/**
 * tsconfig reader/patcher for tsgo compatibility.
 *
 * Reads a real tsconfig.json (resolving `extends`), strips options
 * that tsgo doesn't support, and writes a patched version to /tmp.
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname, resolve } from "path";

interface TsConfig {
  extends?: string;
  compilerOptions?: Record<string, unknown>;
  include?: string[];
  exclude?: string[];
  [key: string]: unknown;
}

/**
 * Options that tsgo has dropped support for.
 * These are automatically removed from the patched config.
 */
const TSGO_REMOVED_OPTIONS = ["baseUrl"] as const;

/**
 * Strip JSON comments (// and /* *\/) while respecting string literals.
 * Also removes trailing commas before } and ].
 */
function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (escape) {
      result += ch;
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      result += ch;
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }

    if (!inString) {
      // Line comment
      if (ch === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
        i--; // let the loop's i++ land on \n
        continue;
      }
      // Block comment
      if (ch === "/" && text[i + 1] === "*") {
        i += 2;
        while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
        i++; // skip past closing /
        continue;
      }
    }

    result += ch;
  }

  // Remove trailing commas before } or ]
  return result.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Read and fully resolve a tsconfig.json, flattening any `extends` chain.
 */
function readTsConfig(filePath: string): TsConfig {
  const raw = readFileSync(filePath, "utf8");
  const stripped = stripJsonComments(raw);
  const config: TsConfig = JSON.parse(stripped);

  if (config.extends) {
    const baseDir = dirname(filePath);
    const basePath = resolve(baseDir, config.extends);
    // Add .json if missing
    const resolvedPath = basePath.endsWith(".json") ? basePath : basePath + ".json";
    const base = readTsConfig(resolvedPath);

    // Merge: base compilerOptions overridden by child
    const merged: TsConfig = {
      ...base,
      ...config,
      compilerOptions: {
        ...base.compilerOptions,
        ...config.compilerOptions,
      },
    };
    delete merged.extends;
    return merged;
  }

  return config;
}

/**
 * Patch a tsconfig for tsgo compatibility:
 * - Remove unsupported options
 * - Ensure paths are valid
 */
function patchForTsgo(config: TsConfig): TsConfig {
  const patched = { ...config };
  patched.compilerOptions = { ...config.compilerOptions };

  for (const opt of TSGO_REMOVED_OPTIONS) {
    delete patched.compilerOptions[opt];
  }

  // Remove non-essential keys that tsgo doesn't need
  delete patched["ts-node"];
  delete patched["watchOptions"];

  return patched;
}

/**
 * Resolve include/exclude glob arrays to absolute paths.
 * tsgo resolves these relative to the config file's directory,
 * so they must be absolute when the config lives in /tmp/.
 */
function resolveGlobs(globs: string[] | undefined, baseDir: string): string[] | undefined {
  if (!globs) return undefined;
  return globs.map(g => {
    // Already absolute → keep as-is
    if (g.startsWith("/")) return g;
    // Resolve relative globs against the original tsconfig's directory
    return join(baseDir, g);
  });
}

/**
 * Read a tsconfig, patch it for tsgo, and write to a temp file.
 * Returns the path to the temp file.
 *
 * include/exclude paths are resolved to absolute so tsgo can find
 * source files even though the config is written to /tmp/.
 */
export function createTsgoConfig(tsconfigPath: string, appName: string): string {
  const config = readTsConfig(tsconfigPath);
  const patched = patchForTsgo(config);

  // Resolve include/exclude relative to the original tsconfig directory
  const configDir = dirname(resolve(tsconfigPath));
  patched.include = resolveGlobs(patched.include, configDir);
  patched.exclude = resolveGlobs(patched.exclude, configDir);

  // Also resolve compilerOptions.paths values if present
  if (patched.compilerOptions?.paths) {
    const paths = patched.compilerOptions.paths as Record<string, string[]>;
    for (const key of Object.keys(paths)) {
      paths[key] = paths[key]!.map(p =>
        p.startsWith("/") ? p : join(configDir, p),
      );
    }
  }

  // Set rootDir so tsgo resolves source files correctly
  if (!patched.compilerOptions) patched.compilerOptions = {};
  if (!patched.compilerOptions.rootDir) {
    patched.compilerOptions.rootDir = configDir;
  }

  const tmpPath = join("/tmp", `rt-typecheck-${appName}.json`);
  writeFileSync(tmpPath, JSON.stringify(patched, null, 2));
  return tmpPath;
}
