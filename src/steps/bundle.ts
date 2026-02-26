import { NexeCompiler, NexeError } from "../compiler";
import { resolve, relative, sep, join } from "path";
import resolveFiles, { resolveSync } from "resolve-dependencies";
import { dequote, STDIN_FLAG, semverGt } from "../util";
import { Readable } from "stream";
import { minimatch } from "minimatch";
import { readdirSync, statSync } from "fs";

type ModuleRule = {
  include?: string[];
  exclude?: string[];
};

function getModuleName(file: string): string | null {
  const parts = file.split(/[\\/]/);
  const idx = parts.lastIndexOf("node_modules");
  if (idx === -1) return null;

  const name = parts[idx + 1];
  if (!name) return null;

  return name.startsWith("@")
    ? parts.slice(idx + 1, idx + 3).join("/")
    : name;
}

function getModuleBasePath(file: string, moduleName: string): string | null {
  const parts = file.split(/[\\/]/);
  const idx = parts.lastIndexOf("node_modules");
  if (idx === -1) return null;

  const baseParts = parts.slice(0, idx + 1);
  if (moduleName.startsWith("@")) {
    baseParts.push(...moduleName.split("/"));
  } else {
    baseParts.push(moduleName);
  }

  return baseParts.join(sep);
}

function getModuleRelativePath(file: string, moduleName: string): string {
  const normalizedFile = file.replace(/\\/g, '/');
  const normalizedModuleName = moduleName.replace(/\\/g, '/');
  
  const marker = `node_modules/${normalizedModuleName}/`;
  const idx = normalizedFile.indexOf(marker);
  
  if (idx === -1) {
    return "";
  }
  
  return normalizedFile.slice(idx + marker.length);
}

function getAllFilesInModule(basePath: string): string[] {
  const files: string[] = [];

  function walk(dir: string) {
    try {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);

          if (stat.isDirectory()) {
            walk(fullPath);
          } else if (stat.isFile()) {
            files.push(fullPath);
          }
        } catch (err) {
          // Skip files we can't read
        }
      }
    } catch (err) {
      // Skip directories we can't read
    }
  }

  walk(basePath);
  return files;
}

function shouldIncludeFile(
  file: string,
  moduleName: string,
  rule: ModuleRule
): boolean {
  const rel = getModuleRelativePath(file, moduleName);

  if (!rel) {
    return false;
  }

  // Always include package.json
  if (rel === "package.json") {
    return true;
  }

  // If there's an include list, file MUST match it
  if (rule.include && rule.include.length > 0) {
    const matchesInclude = rule.include.some((g) => minimatch(rel, g));
    if (!matchesInclude) {
      return false;
    }
  }

  // Check exclude patterns
  if (rule.exclude && rule.exclude.length > 0) {
    const matchesExclude = rule.exclude.some((g) => minimatch(rel, g));
    if (matchesExclude) {
      return false;
    }
  }

  return true;
}

function getStdIn(stdin: Readable): Promise<string> {
  let out = "";
  return new Promise((resolve) => {
    stdin
      .setEncoding("utf8")
      .on("readable", () => {
        let current;
        while ((current = stdin.read())) {
          out += current;
        }
      })
      .on("end", () => resolve(out.trim()));
    setTimeout(() => {
      if (!out.trim()) {
        resolve(out.trim());
      }
    }, 1000);
  });
}

export default async function bundle(compiler: NexeCompiler, next: any) {
  const { bundle: doBundle, cwd, input: inputPath, bundleRules } = compiler.options;
  
  const rules: Record<string, ModuleRule> =
    bundleRules && Object.keys(bundleRules).length ? bundleRules : {};

  let input = inputPath;
  compiler.entrypoint = "./" + relative(cwd, input);

  if (semverGt(compiler.target.version, "11.99")) {
    compiler.startup = "";
  } else {
    compiler.startup = ';require("module").runMain();';
  }

  if (!doBundle) {
    await compiler.addResource(resolve(cwd, input));
    return next();
  }

  let code = "";
  if (typeof doBundle === "string") {
    code = await require(doBundle).createBundle(compiler.options);
  }

  if (
    input === STDIN_FLAG &&
    (code = code || dequote(await getStdIn(process.stdin)))
  ) {
    compiler.stdinUsed = true;
    compiler.entrypoint = "./__nexe_stdin.js";
    await compiler.addResource(resolve(cwd, compiler.entrypoint), code);
    return next();
  }

  if (input === STDIN_FLAG) {
    const maybeInput = resolveSync(cwd, ".");
    if (!maybeInput || !maybeInput.absPath) {
      throw new NexeError("No valid input detected");
    }
    input = maybeInput.absPath;
    compiler.entrypoint = "./" + relative(cwd, input);
  }

  const step = compiler.log.step("Resolving dependencies...");

  const { files, warnings } = await resolveFiles(input, {
    cwd,
    expand: "variable",
    loadContent: false,
  });

  if (
    warnings.filter(
      (x) => x.startsWith("Error parsing file") && !x.includes("node_modules")
    ).length
  ) {
    throw new NexeError("Parsing Error:\n" + warnings.join("\n"));
  }

  // If no bundle rules, use original behavior
  if (Object.keys(rules).length === 0) {
    const pkgJsonsToAdd = new Set<string>();

    await Promise.all(
      Object.entries(files).map(([key]) => {
        step.log(`Including dependency: ${key}`);
        // Collect the package.json for each bundled module so Node can
        // resolve the correct entry point (main/exports) at runtime.
        const moduleName = getModuleName(key);
        if (moduleName) {
          const basePath = getModuleBasePath(key, moduleName);
          if (basePath) {
            pkgJsonsToAdd.add(join(basePath, "package.json"));
          }
        }
        return compiler.addResource(key);
      })
    );

    await Promise.all(
      Array.from(pkgJsonsToAdd).map((pkgJson) => {
        try {
          statSync(pkgJson);
          step.log(`Including package.json: ${pkgJson}`);
          return compiler.addResource(pkgJson);
        } catch (e) {
          // package.json doesn't exist on disk, skip
        }
      })
    );

    return next();
  }

  // Track modules with explicit bundle rules
  const modulesWithRules = new Map<string, string>();

  for (const file of Object.keys(files)) {
    const moduleName = getModuleName(file);
    if (moduleName && rules[moduleName] && !modulesWithRules.has(moduleName)) {
      const basePath = getModuleBasePath(file, moduleName);
      if (basePath) {
        modulesWithRules.set(moduleName, basePath);
      }
    }
  }

  // Collect files to include
  const filesToInclude = new Set<string>();

  // Add all files that AREN'T from modules with rules (preserve original behavior)
  for (const file of Object.keys(files)) {
    const moduleName = getModuleName(file);
    
    // If this file is from a module with rules, skip it here
    if (moduleName && modulesWithRules.has(moduleName)) {
      continue;
    }
    
    // All other files get included as normal
    filesToInclude.add(file);
  }

  // For modules WITH rules: scan and filter
  for (const [moduleName, basePath] of modulesWithRules) {
    const rule = rules[moduleName];

    step.log(`Scanning ${moduleName} with bundle rules...`);

    const moduleFiles = getAllFilesInModule(basePath);

    for (const file of moduleFiles) {
      const rel = getModuleRelativePath(file, moduleName);
      
      if (shouldIncludeFile(file, moduleName, rule)) {
        filesToInclude.add(file);
        step.log(`Including ${rel} from ${moduleName}`);
      } else {
        step.log(`Excluding ${rel} from ${moduleName}`);
      }
    }
  }

  // Add all files
  await Promise.all(
    Array.from(filesToInclude).map((file) => {
      step.log(`Including dependency: ${file}`);
      return compiler.addResource(file);
    })
  );

  return next();
}