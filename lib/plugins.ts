/**
 * User plugins: discovery, validation, and command-tree integration.
 *
 * Plugins live at ~/.rt/plugins/<name>/plugin.json. Discovery is structural
 * only (no plugin code executes); handlers are lazy import() closures, so a
 * broken plugin can only ever fail its own command, never rt itself.
 */

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { CommandArg, CommandNode, CommandContext } from "./command-tree.ts";
import { makeApi, ensurePluginApiDir } from "./plugin-api.ts";
import { rtDir } from "./rt-paths.ts";

export interface PluginNode {
  description: string;
  module?: string;
  fn?: string;
  exec?: string | string[];
  subcommands?: Record<string, PluginNode>;
  aliases?: string[];
  hidden?: boolean;
  context?: "repo" | "worktree";
  requiresTTY?: boolean;
  fullscreen?: boolean;
  args?: CommandArg[];
}

export interface PluginManifest {
  name: string;
  description?: string;
  apiVersion: number;
  commands: Record<string, PluginNode>;
}

const MANIFEST_KEYS = new Set(["name", "description", "apiVersion", "commands"]);
const NODE_KEYS = new Set([
  "description", "module", "fn", "exec", "subcommands",
  "aliases", "hidden", "context", "requiresTTY", "fullscreen", "args",
]);
const ARG_KEYS = new Set(["name", "flag", "type", "hint", "placeholder", "default", "options"]);
const ARG_TYPES = new Set(["text", "boolean", "select"]);
export const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function validateArgs(args: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(args)) {
    errors.push(`${path}: args must be an array`);
    return;
  }
  args.forEach((arg, i) => {
    const p = `${path}: args[${i}]`;
    if (!arg || typeof arg !== "object") {
      errors.push(`${p} must be an object`);
      return;
    }
    for (const k of Object.keys(arg)) if (!ARG_KEYS.has(k)) errors.push(`${p} unknown field "${k}"`);
    if (typeof arg.name !== "string" || !arg.name) errors.push(`${p} missing name`);
    if (!ARG_TYPES.has(arg.type)) errors.push(`${p} type must be one of text|boolean|select`);
    if (arg.type === "select" && !Array.isArray(arg.options)) errors.push(`${p} select args need options`);
  });
}

function validateNode(node: any, path: string, errors: string[]): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  for (const k of Object.keys(node)) {
    if (!NODE_KEYS.has(k)) errors.push(`${path}: unknown field "${k}"`);
  }
  if (typeof node.description !== "string" || !node.description) {
    errors.push(`${path}: missing description`);
  }

  const kinds = ["module", "exec", "subcommands"].filter((k) => node[k] !== undefined);
  if (kinds.length !== 1) {
    errors.push(`${path}: needs exactly one of module, exec, or subcommands (got ${kinds.length ? kinds.join("+") : "none"})`);
  }

  if (node.module !== undefined && typeof node.module !== "string") errors.push(`${path}: module must be a string`);
  if (node.fn !== undefined) {
    if (typeof node.fn !== "string") errors.push(`${path}: fn must be a string`);
    if (node.module === undefined) errors.push(`${path}: "fn" requires "module"`);
  }
  if (node.exec !== undefined) {
    const ok = typeof node.exec === "string"
      ? node.exec.length > 0
      : Array.isArray(node.exec) && node.exec.length > 0 && node.exec.every((s: unknown) => typeof s === "string");
    if (!ok) errors.push(`${path}: exec must be a non-empty string or string array`);
  }
  if (node.aliases !== undefined && (!Array.isArray(node.aliases) || node.aliases.some((a: unknown) => typeof a !== "string"))) {
    errors.push(`${path}: aliases must be a string array`);
  }
  if (node.context !== undefined && node.context !== "repo" && node.context !== "worktree") {
    errors.push(`${path}: context must be "repo" or "worktree"`);
  }
  for (const key of ["hidden", "requiresTTY", "fullscreen"] as const) {
    if (node[key] !== undefined && typeof node[key] !== "boolean") errors.push(`${path}: ${key} must be a boolean`);
  }
  if (node.args !== undefined) validateArgs(node.args, path, errors);

  if (node.subcommands !== undefined) {
    if (!node.subcommands || typeof node.subcommands !== "object" || Array.isArray(node.subcommands)) {
      errors.push(`${path}: subcommands must be an object`);
    } else {
      for (const [name, sub] of Object.entries(node.subcommands)) {
        if (!KEBAB_RE.test(name)) errors.push(`${path}.${name}: command names must be kebab-case`);
        validateNode(sub, `${path}.${name}`, errors);
      }
    }
  }
}

/** Structural validation only; never executes plugin code. Empty array = valid. */
export function validateManifest(raw: unknown): string[] {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["plugin.json must be a JSON object"];
  const manifest = raw as Record<string, unknown>;

  for (const k of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.has(k)) errors.push(`unknown field "${k}"`);
  }
  if (manifest.apiVersion !== 1) {
    errors.push(`apiVersion must be 1 (got ${JSON.stringify(manifest.apiVersion)}); this rt may be too old for this plugin`);
  }
  if (typeof manifest.name !== "string" || !KEBAB_RE.test(manifest.name)) {
    errors.push("name must be a kebab-case string");
  }
  if (manifest.description !== undefined && typeof manifest.description !== "string") {
    errors.push("description must be a string");
  }
  if (!manifest.commands || typeof manifest.commands !== "object" || Array.isArray(manifest.commands)) {
    errors.push("commands must be an object");
  } else if (Object.keys(manifest.commands).length === 0) {
    errors.push("commands: must declare at least one command");
  } else {
    for (const [name, node] of Object.entries(manifest.commands)) {
      if (!KEBAB_RE.test(name)) errors.push(`${name}: command names must be kebab-case`);
      validateNode(node, name, errors);
    }
  }
  return errors;
}

/** A plugin exec target exited non-zero; carries the child's exit code. */
export class ExecFailure extends Error {
  constructor(public readonly code: number, label: string) {
    super(`${label} exited with code ${code}`);
  }
}

export function toCommandNode(pluginName: string, pluginDir: string, node: PluginNode): CommandNode {
  const out: CommandNode = {
    description: node.description,
    aliases: node.aliases,
    hidden: node.hidden,
    context: node.context,
    requiresTTY: node.requiresTTY,
    fullscreen: node.fullscreen,
    args: node.args,
  };

  if (node.subcommands) {
    out.subcommands = Object.fromEntries(
      Object.entries(node.subcommands).map(([name, sub]) => [name, toCommandNode(pluginName, pluginDir, sub)]),
    );
    return out;
  }

  if (node.module) {
    const modulePath = resolve(pluginDir, node.module);
    const fnName = node.fn ?? "run";
    out.handler = async (args: string[], ctx: CommandContext) => {
      let mod: Record<string, unknown>;
      try {
        mod = await import(modulePath);
      } catch (err) {
        throw new Error(`plugin ${pluginName}: failed to load ${node.module}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const fn = mod[fnName];
      if (typeof fn !== "function") {
        throw new Error(`plugin ${pluginName}: ${node.module} does not export "${fnName}"`);
      }
      await fn(args, { ...ctx, rt: makeApi(pluginName) });
    };
    return out;
  }

  const spec = node.exec!;
  const [cmd, ...fixed] = Array.isArray(spec) ? spec : [spec];
  const resolved = cmd!.includes("/") ? resolve(pluginDir, cmd!) : cmd!;
  out.handler = async (args: string[], ctx: CommandContext) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      RT_PLUGIN_NAME: pluginName,
      RT_PLUGIN_DATA_DIR: join(rtDir(), "plugin-data", pluginName),
    };
    if (ctx.identity) {
      env.RT_REPO_NAME = ctx.identity.repoName;
      env.RT_REPO_ROOT = ctx.identity.repoRoot;
      env.RT_REPO_DATA_DIR = ctx.identity.dataDir;
      env.RT_REMOTE_URL = ctx.identity.remoteUrl;
      env.RT_BASE_URL = ctx.identity.baseUrl;
      env.RT_AUTO_RESOLVED = ctx.autoResolved ? "1" : "0";
    }
    const result = spawnSync(resolved, [...fixed, ...args], { stdio: "inherit", env });
    if (result.error) {
      throw new Error(`plugin ${pluginName}: cannot run ${resolved}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new ExecFailure(result.status ?? 1, `plugin ${pluginName}: ${cmd}`);
    }
  };
  return out;
}

export interface DiscoveredPlugin {
  dirName: string;
  dir: string;
  /** Parsed manifest when structurally valid, else null (see errors). */
  manifest: PluginManifest | null;
  errors: string[];
}

export function pluginsDir(): string {
  return join(rtDir(), "plugins");
}

/** Structural discovery: readdir + parse + validate. Never executes plugin code, never throws. */
export function discoverPlugins(): DiscoveredPlugin[] {
  const root = pluginsDir();
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root).sort();
  } catch (err) {
    return [{
      dirName: "(plugins dir)",
      dir: root,
      manifest: null,
      errors: [`cannot read plugins directory: ${err instanceof Error ? err.message : String(err)}`],
    }];
  }
  const out: DiscoveredPlugin[] = [];
  for (const dirName of entries) {
    const dir = join(root, dirName);
    const manifestPath = join(dir, "plugin.json");
    if (!existsSync(manifestPath)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      out.push({ dirName, dir, manifest: null, errors: [`plugin.json is unreadable or not valid JSON (${err instanceof Error ? err.message : String(err)})`] });
      continue;
    }
    const errors = validateManifest(raw);
    out.push({ dirName, dir, manifest: errors.length ? null : (raw as PluginManifest), errors });
  }
  return out;
}

/**
 * Merge plugin commands into the built-in tree. Built-ins always win;
 * plugin-vs-plugin, first by directory sort order wins. Collisions check
 * names AND aliases. Losing commands are not mounted; every skip warns
 * with provenance. A clean setup produces zero output.
 */
export function loadPluginTree(
  builtins: Record<string, CommandNode>,
  warn: (msg: string) => void = (m) => console.error(`  [rt] ${m}`),
): Record<string, CommandNode> {
  ensurePluginApiDir();
  const tree = { ...builtins };

  const claimed = new Map<string, string>();
  for (const [name, node] of Object.entries(builtins)) {
    claimed.set(name, "built-in");
    for (const alias of node.aliases ?? []) claimed.set(alias, "built-in");
  }

  for (const plugin of discoverPlugins()) {
    if (plugin.errors.length) {
      warn(`skipping plugin "${plugin.dirName}": ${plugin.errors.join("; ")}`);
      continue;
    }
    const manifest = plugin.manifest!;
    if (manifest.name !== plugin.dirName) {
      warn(`plugin "${plugin.dirName}": manifest name "${manifest.name}" differs from directory name`);
    }
    for (const [name, node] of Object.entries(manifest.commands)) {
      const names = [name, ...(node.aliases ?? [])];
      const conflict = names.find((n) => claimed.has(n));
      if (conflict) {
        const owner = claimed.get(conflict)!;
        const what = owner === "built-in" ? "collides with built-in" : `already provided by ${owner}`;
        warn(`plugin "${manifest.name}": command "${name}" ${what} ("${conflict}") ... not mounted`);
        continue;
      }
      for (const n of names) claimed.set(n, `plugin "${manifest.name}"`);
      tree[name] = toCommandNode(manifest.name, plugin.dir, node);
    }
  }
  return tree;
}

/** Create ~/.rt/plugins/<name>/ with a starter command, tsconfig, and package.json. */
export function scaffoldPlugin(name: string): string {
  if (!KEBAB_RE.test(name)) throw new Error(`plugin name must be kebab-case (got "${name}")`);
  const dir = join(pluginsDir(), name);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  ensurePluginApiDir();
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, "plugin.json"), JSON.stringify({
    name,
    apiVersion: 1,
    commands: {
      [name]: { description: `Describe what ${name} does`, module: `./${name}.ts` },
    },
  }, null, 2) + "\n");

  writeFileSync(join(dir, `${name}.ts`), `import type { RtCommandContext } from "rt-plugin";

export async function run(args: string[], ctx: RtCommandContext) {
  const runs = ctx.rt.store<number>("runs");
  const count = ((await runs.get()) ?? 0) + 1;
  await runs.set(count);
  console.log(\`hello from ${name} (run #\${count}, args: \${JSON.stringify(args)})\`);
}
`);

  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      lib: ["esnext"], module: "esnext", target: "esnext",
      moduleResolution: "bundler", allowImportingTsExtensions: true,
      noEmit: true, strict: true, types: ["bun"], skipLibCheck: true,
    },
  }, null, 2) + "\n");

  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name, private: true,
    devDependencies: {
      "rt-plugin": "file:../../plugin-api",
      "@types/bun": "^1.2.0",
      "typescript": "^5.5.0",
    },
  }, null, 2) + "\n");

  return dir;
}
