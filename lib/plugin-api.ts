/**
 * Injected plugin API + the on-disk "rt-plugin" types package.
 *
 * The API object is created per plugin invocation and passed to plugin
 * command functions as ctx.rt. Plugins cannot import rt internals (they are
 * compiled into the binary), so this injection is the entire runtime surface.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { rtDir } from "./rt-paths.ts";
import { readJson, writeJson } from "./json-store.ts";
import type { RtApi } from "./plugin-api-types.ts";

// @ts-expect-error TS doesn't understand import attributes, but Bun does
import dtsText from "./plugin-api-types.ts" with { type: "text" };

declare const RT_VERSION: string;

const STORE_KEY_RE = /^[A-Za-z0-9._-]+$/;

export function pluginApiDir(): string {
  return join(rtDir(), "plugin-api");
}

/** "v1.2.3" ... "1.2.3"; anything non-semver (dev builds) ... "0.0.0". */
function packageVersion(): string {
  const raw =
    (typeof RT_VERSION !== "undefined" ? RT_VERSION : null) ??
    process.env.RT_VERSION ?? "dev";
  return /^v?(\d+\.\d+\.\d+)/.exec(raw)?.[1] ?? "0.0.0";
}

/**
 * Write ~/.rt/plugin-api/ (the local "rt-plugin" package plugin authors
 * depend on via file:) whenever the embedded contract differs from what is
 * on disk. Content comparison, not version stamps: the bytes are the truth.
 */
export function ensurePluginApiDir(): void {
  try {
    const dir = pluginApiDir();
    const dtsPath = join(dir, "index.d.ts");
    let existing: string | null = null;
    try {
      existing = readFileSync(dtsPath, "utf8");
    } catch {
      // first run: file doesn't exist yet
    }
    if (existing === dtsText) return;

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        { name: "rt-plugin", version: packageVersion(), types: "index.d.ts", main: "index.js" },
        null, 2,
      ) + "\n",
    );
    writeFileSync(dtsPath, dtsText);
    writeFileSync(
      join(dir, "index.js"),
      'throw new Error("rt-plugin is types-only; the API is injected at runtime via the ctx argument");\n',
    );
  } catch (err) {
    console.error(`  [rt] could not refresh plugin-api types: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writePluginLog(plugin: string, level: string, msg: string, data?: object): void {
  if (level === "debug" && process.env.RT_LOG_LEVEL !== "debug") return;
  try {
    const dir = join(rtDir(), "logs");
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const line = JSON.stringify({ time: new Date().toISOString(), level, plugin, msg, ...data }) + "\n";
    appendFileSync(join(dir, `plugins.${day}.log`), line);
  } catch {
    // logging must never break a command
  }
}

export function makeApi(pluginName: string): RtApi {
  const dataDir = join(rtDir(), "plugin-data", pluginName);
  return {
    async pick(items, opts) {
      const { filterableSelect } = await import("./rt-render.tsx");
      const options = items.map((i) =>
        typeof i === "string"
          ? { value: i, label: i }
          : { value: i.value, label: i.label ?? i.value, hint: i.hint },
      );
      return filterableSelect({ message: opts?.label ?? "pick", options });
    },
    async prompt(label, opts) {
      const { textInput } = await import("./rt-render.tsx");
      return textInput({ message: label, placeholder: opts?.placeholder, defaultValue: opts?.default });
    },
    async confirm(label, opts) {
      const { confirm } = await import("./rt-render.tsx");
      return confirm({ message: label, initialValue: opts?.default });
    },
    store<T>(key: string) {
      if (!STORE_KEY_RE.test(key)) {
        throw new Error(`invalid store key "${key}" (allowed: letters, digits, dot, underscore, hyphen)`);
      }
      const file = join(dataDir, `${key}.json`);
      return {
        async get(): Promise<T | null> {
          return readJson<T | null>(file, null);
        },
        async set(value: T): Promise<void> {
          writeJson(file, value);
        },
      };
    },
    log: {
      info: (msg, data) => writePluginLog(pluginName, "info", msg, data),
      warn: (msg, data) => writePluginLog(pluginName, "warn", msg, data),
      debug: (msg, data) => writePluginLog(pluginName, "debug", msg, data),
    },
  };
}
