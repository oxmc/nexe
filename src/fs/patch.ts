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
      return -constants.ENOENT;
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

  let _origFindPath: ((...args: any[]) => any) | null = null;
  try {
    const Module = require("module");
    const nodePath = require("path");
    const capturedOrigFindPath = (Module as any)._findPath;
    if (typeof capturedOrigFindPath === "function") {
      _origFindPath = capturedOrigFindPath;
      (Module as any)._findPath = function nexeFindPath(this: any, ...args: any[]) {
        // Try original first
        let result: any;
        try {
          result = capturedOrigFindPath.apply(this, args);
        } catch (_) {
          result = false;
        }
        if (result) return result;

        const request: string = args[0];
        // Only handle bare module specifiers
        if (!request || request[0] === "." || nodePath.isAbsolute(request)) {
          return result;
        }

        // Use snapshot node_modules as the base for all bare modules
        const basePath = "/snapshot/node_modules";
        const pkgJsonPath = nodePath.posix.join(basePath, request, "package.json");
        log(`_findPath trying snapshot package.json: ${pkgJsonPath}`);
        let pkg: any;
        try {
          pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8") as string);
        } catch (e) {
          return result; // not found in snapshot
        }

        // 1. Try exports field with appropriate conditions (CJS, Node)
        if (pkg.exports) {
          const conditions = ["require", "node", "default"];
          const exportTarget = resolvePackageExports(pkg.exports, conditions);
          if (exportTarget) {
            const candidate = nodePath.posix.join(basePath, request, exportTarget);
            log(`_findPath trying exports target: ${candidate}`);
            if (isFile(candidate)) return candidate;
            // Try with extensions if the export target doesn't have one
            for (const ext of [".js", ".json", ".node"]) {
              const withExt = candidate + ext;
              if (isFile(withExt)) return withExt;
            }
          }
        }

        // 2. Fallback to main field
        let main = "index.js";
        if (typeof pkg.main === "string") {
          main = pkg.main;
        }

        // Normalize main path
        if (main.startsWith("./")) main = main.slice(2);
        if (!main || main === ".") main = "index.js";
        if (main.endsWith("/")) main += "index.js";

        const mainPath = nodePath.posix.join(basePath, request, main);
        log(`_findPath trying main: ${mainPath}`);

        // Detailed check for main
        try {
          const st = fs.statSync(mainPath);
          if (st.isFile()) return mainPath;
          if (st.isDirectory()) {
            const idxPath = nodePath.posix.join(mainPath, "index.js");
            if (isFile(idxPath)) return idxPath;
          }
        } catch (e) {
          // mainPath may not exist; proceed to extension checks
        }

        // 3. Try with extensions
        for (const ext of [".js", ".json", ".node"]) {
          const withExt = mainPath + ext;
          if (isFile(withExt)) return withExt;
        }

        // 4. Common patterns: if main is missing, look for index.js in the package root
        const fallbackIndex = nodePath.posix.join(basePath, request, "index.js");
        if (isFile(fallbackIndex)) return fallbackIndex;

        // 5. If package uses a dist subdirectory (like axios), try dist/index.js or dist/<name>.js
        const distIndex = nodePath.posix.join(basePath, request, "dist", "index.js");
        if (isFile(distIndex)) return distIndex;
        const distMain = nodePath.posix.join(basePath, request, "dist", request + ".js");
        if (isFile(distMain)) return distMain;

        return result;
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
