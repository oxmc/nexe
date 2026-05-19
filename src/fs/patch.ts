import { ZipFS, getLibzipSync } from "@yarnpkg/libzip";
import { patchFs, PosixFS, NodeFS } from "@yarnpkg/fslib";
import { SnapshotZipFS } from "./SnapshotZipFS";
import * as assert from "assert";
import * as constants from "constants";
import { dirname, relative, sep } from "path";

export interface NexeHeader {
  blobPath: string;
  layout: {
    resourceStart: number;
    resourceSize: number;
    contentSize: number;
    contentStart: number;
  };
}

let originalFsMethods: any = null;
let lazyRestoreFs = () => {};
const patches = (process as any).nexe.patches || {};
const originalPatches = { ...patches };
delete (process as any).nexe;

function shimFs(binary: NexeHeader, fs: typeof import("fs") = require("fs")) {
  if (originalFsMethods !== null) {
    return;
  }

  originalFsMethods = Object.assign({}, fs);

  const realFs: typeof fs = { ...fs };
  const nodeFs = new NodeFS(realFs);

  const blob = Buffer.allocUnsafe(binary.layout.resourceSize);
  const blobFd = realFs.openSync(binary.blobPath, "r");
  const bytesRead = realFs.readSync(
    blobFd,
    blob,
    0,
    binary.layout.resourceSize,
    binary.layout.resourceStart
  );
  assert.equal(bytesRead, binary.layout.resourceSize);

  const zipFs = new ZipFS(blob, { readOnly: true });
  const snapshotZipFS = new SnapshotZipFS({
    libzip: getLibzipSync(),
    zipFs,
    baseFs: nodeFs,
    root: dirname(process.argv[0]), // executable directory = original project root
  });
  const posixSnapshotZipFs = new PosixFS(snapshotZipFS);
  patchFs(fs, posixSnapshotZipFs); // patches global fs

  // Capture the project root for path mapping
  const projectRoot = dirname(process.argv[0]);
  const drive = projectRoot.slice(0, 2); // e.g., "C:"

  // Enable logging with DEBUG=nexe:require
  let log = (_: string) => true;
  if ((process.env.DEBUG || "").toLowerCase().includes("nexe:require")) {
    process.stderr.write(
      `[nexe] - FILES ${JSON.stringify(
        // @ts-ignore - accessing private property for debugging
        Array.from(zipFs.entries.keys()),
        null,
        4
      )}\n`
    );
    process.stderr.write(
      `[nexe] - DIRECTORIES ${JSON.stringify(
        // @ts-ignore - accessing private property for debugging
        Array.from(zipFs.listings.keys()),
        null,
        4
      )}\n`
    );
    log = (text: string) => process.stderr.write(`[nexe] - ${text}\n`);
  }

  /**
   * Convert a Windows path to the snapshot POSIX path.
   * Handles:
   *   - Paths under the original project root (e.g., C:\Users\oxmc\Desktop\src\entry.js → /snapshot/src/entry.js)
   *   - Paths that have been converted to C:\snapshot\... (from _findPath returning /snapshot/...)
   *   - Already POSIX /snapshot/... paths (return as-is)
   */
  function toSnapshotPath(filePath: string): string {
    // Already a POSIX snapshot path
    if (filePath.startsWith("/snapshot/")) {
      return filePath;
    }
    // Handle Windows-style snapshot path: e.g., C:\snapshot\src\entry.js
    if (filePath.startsWith(drive + "\\snapshot\\")) {
      return "/snapshot/" + filePath.slice(drive.length + 9).replace(/\\/g, "/");
    }
    // Path under original project root
    if (filePath.startsWith(projectRoot)) {
      const rel = relative(projectRoot, filePath);
      return "/snapshot/" + rel.replace(/\\/g, "/");
    }
    // Not mappable – return unchanged (will likely fail)
    return filePath;
  }

  // --- Internal Module Patches (unconditionally assigned) ---

  function internalModuleReadFile(this: any, original: any, ...args: any[]) {
    // Strip Windows extended-length path prefix if present
    let filePath = typeof args[0] === "string" ? args[0] : "";
    if (filePath.startsWith("\\\\?\\")) {
      filePath = filePath.slice(4);
    }
    const mappedPath = toSnapshotPath(filePath);
    log(`internalModuleReadFile ${filePath} -> ${mappedPath}`);
    try {
      // Use the patched fs (which already sees the zip)
      return fs.readFileSync(mappedPath, "utf-8");
    } catch (e) {
      return "";
    }
  }

  patches.internalModuleReadFile = internalModuleReadFile;

  // internalModuleReadJSON should return a string (or undefined) in Node 22
  patches.internalModuleReadJSON = function (this: any, original: any, ...args: any[]) {
    const content = internalModuleReadFile.call(this, original, ...args);
    return content === "" ? undefined : content;
  };

  // Handle Node 22+ signature: first arg is context (non-string), second is path
  function internalModuleStat(this: any, original: any, ...args: any[]) {
    const target = args[0];
    let statPath: string;

    // Node 22+: args[0] is context (often a buffer), args[1] is the path string
    if (typeof target === "number") {
      // file descriptor case – unchanged
      try {
        originalFsMethods.fstatSync(target);
        return 0;
      } catch (e) {
        return -constants.ENOENT;
      }
    }

    if (typeof target === "string") {
      // Node <22 or when a string is passed directly
      statPath = target;
    } else {
      // Node 22+: path is the second argument
      statPath = args[1];
    }

    if (typeof statPath !== "string") {
      // Unexpected: fallback to original
      return original.call(this, ...args);
    }

    // Strip Windows extended-length prefix
    if (statPath.startsWith("\\\\?\\")) {
      statPath = statPath.slice(4);
    }

    const mappedPath = toSnapshotPath(statPath);
    log(`internalModuleStat ${statPath} -> ${mappedPath}`);

    try {
      const stat = fs.statSync(mappedPath);
      return stat.isDirectory() ? 1 : 0;
    } catch (e) {
      // VFS has no entry — check the real filesystem at the original path.
      // This handles dynamically created files (e.g. written via the patched fs)
      // that don't exist in the zip.
      try {
        const realStat = originalFsMethods.statSync(statPath);
        return realStat.isDirectory() ? 1 : 0;
      } catch (e2) {
        return -constants.ENOENT;
      }
    }
  }

  patches.internalModuleStat = internalModuleStat;

  // --- Patch Module._findPath with a correct exports resolver ---

  // Helper to check if a path exists and is a file
  function isFile(p: string): boolean {
    try {
      const stat = fs.statSync(p);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  // Recursive exports resolver following Node's conditional exports
  function resolvePackageExports(exports: any, conditions: string[]): string | null {
    if (typeof exports === "string") {
      return exports;
    }
    if (!exports || typeof exports !== "object") {
      return null;
    }
    // Handle "." subpath first (for bare module, we always start with ".")
    const subExports = exports["."] ?? exports;
    return resolveExportsObject(subExports, conditions);
  }

  function resolveExportsObject(obj: any, conditions: string[]): string | null {
    if (typeof obj === "string") {
      return obj;
    }
    if (!obj || typeof obj !== "object") {
      return null;
    }
    // Iterate over keys in order; if a key matches a condition, take that branch
    for (const key of Object.keys(obj)) {
      if (conditions.includes(key)) {
        const value = obj[key];
        if (typeof value === "string") {
          return value;
        }
        if (value && typeof value === "object") {
          const nested = resolveExportsObject(value, conditions);
          if (nested) return nested;
        }
      }
    }
    // If no matching condition, try "default" if not already tried
    if (!conditions.includes("default") && obj.default) {
      const def = obj.default;
      if (typeof def === "string") return def;
      if (def && typeof def === "object") {
        return resolveExportsObject(def, conditions);
      }
    }
    return null;
  }

  function resolveFromPkg(
    pkg: any,
    basePath: string,
    request: string,
    nodePath: any,
    logFn: (s: string) => any,
    isFileFn: (p: string) => boolean,
    fsMod: typeof import("fs")
  ): string | null {
    // 1. exports field
    if (pkg.exports) {
      const conditions = ["require", "node", "default"];
      const exportTarget = resolvePackageExports(pkg.exports, conditions);
      if (exportTarget) {
        const candidate = nodePath.posix.join(basePath, request, exportTarget);
        logFn(`_findPath exports target: ${candidate}`);
        if (isFileFn(candidate)) return candidate;
        for (const ext of [".js", ".json", ".node"]) {
          const withExt = candidate + ext;
          if (isFileFn(withExt)) return withExt;
        }
      }
    }

    // 2. main field
    let main = "index.js";
    if (typeof pkg.main === "string") main = pkg.main;
    if (main.startsWith("./")) main = main.slice(2);
    if (!main || main === ".") main = "index.js";
    if (main.endsWith("/")) main += "index.js";

    const mainPath = nodePath.posix.join(basePath, request, main);
    logFn(`_findPath main: ${mainPath}`);
    try {
      const st = fsMod.statSync(mainPath);
      if (st.isFile()) return mainPath;
      if (st.isDirectory()) {
        const idxPath = nodePath.posix.join(mainPath, "index.js");
        if (isFileFn(idxPath)) return idxPath;
      }
    } catch (_) {}

    for (const ext of [".js", ".json", ".node"]) {
      const withExt = mainPath + ext;
      if (isFileFn(withExt)) return withExt;
    }

    // 3. index.js fallback only when main not explicitly set
    if (typeof pkg.main !== "string") {
      const fallbackIndex = nodePath.posix.join(basePath, request, "index.js");
      if (isFileFn(fallbackIndex)) return fallbackIndex;
    }

    // 4. dist subdirectory (axios-style)
    const distIndex = nodePath.posix.join(basePath, request, "dist", "index.js");
    if (isFileFn(distIndex)) return distIndex;
    const distMain = nodePath.posix.join(basePath, request, "dist", request + ".js");
    if (isFileFn(distMain)) return distMain;

    return null;
  }

  let _origFindPath: ((...args: any[]) => any) | null = null;
  try {
    const Module = require("module");
    const nodePath = require("path");
    const capturedOrigFindPath = (Module as any)._findPath;
    if (typeof capturedOrigFindPath === "function") {
      _origFindPath = capturedOrigFindPath;
      (Module as any)._findPath = function nexeFindPath(this: any, ...args: any[]) {
        const request: string = args[0];

        // For bare module specifiers, try VFS first. Node 22 removed
        // internalModuleReadJSON from process.binding('fs'), so _findPath can
        // no longer read package.json from the VFS and falls back to index.js.
        // Our code reads package.json via the patched fs.readFileSync which works.
        if (request && request[0] !== "." && !nodePath.isAbsolute(request)) {
          const basePath = "/snapshot/node_modules";
          const pkgJsonPath = nodePath.posix.join(basePath, request, "package.json");
          let pkg: any;
          try {
            pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8") as string);
          } catch (_) {
            pkg = null;
          }
          if (pkg) {
            const vfsResult = resolveFromPkg(pkg, basePath, request, nodePath, log, isFile, fs);
            if (vfsResult) {
              log(`_findPath VFS resolved ${request} -> ${vfsResult}`);
              return vfsResult;
            }
          }
        }

        // Fall back to original for everything else (real fs, relative, absolute)
        let result: any;
        try {
          result = capturedOrigFindPath.apply(this, args);
        } catch (_) {
          result = false;
        }
        if (result) return result;

        // Secondary VFS fallback for paths that couldn't be resolved above
        // (e.g. bare specifier where package.json wasn't found in /snapshot)
        if (!request || request[0] === "." || nodePath.isAbsolute(request)) {
          return result;
        }

        // Use snapshot node_modules as the base for all bare modules
        const basePath2 = "/snapshot/node_modules";
        const pkgJsonPath2 = nodePath.posix.join(basePath2, request, "package.json");
        log(`_findPath secondary snapshot check: ${pkgJsonPath2}`);
        let pkg2: any;
        try {
          pkg2 = JSON.parse(fs.readFileSync(pkgJsonPath2, "utf8") as string);
        } catch (_) {
          return result;
        }
        return resolveFromPkg(pkg2, basePath2, request, nodePath, log, isFile, fs) ?? result;
      };
    }
  } catch (_) {
    // Patching _findPath failed, ignore
  }

  lazyRestoreFs = () => {
    Object.assign(fs, originalFsMethods);
    Object.assign(patches, originalPatches);
    if (_origFindPath !== null) {
      try {
        const Module = require("module");
        (Module as any)._findPath = _origFindPath;
      } catch (_) {}
      _origFindPath = null;
    }
    lazyRestoreFs = () => {};
  };
}

function restoreFs() {
  lazyRestoreFs();
}

export { shimFs, restoreFs };
