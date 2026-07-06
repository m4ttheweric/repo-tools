/**
 * User plugins: discovery, validation, and command-tree integration.
 *
 * Plugins live at ~/.rt/plugins/<name>/plugin.json. Discovery is structural
 * only (no plugin code executes); handlers are lazy import() closures, so a
 * broken plugin can only ever fail its own command, never rt itself.
 */

import type { CommandArg } from "./command-tree.ts";

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
