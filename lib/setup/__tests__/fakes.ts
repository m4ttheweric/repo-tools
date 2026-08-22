/**
 * Shared in-memory Probes fake for setup validator/step tests. Every write
 * (files, symlinks, exec argv, tray/fetch calls) lands in `.calls` so tests
 * assert on what a step actually did without touching the real machine.
 */

import { basename, dirname } from "path";
import type { TrayClient } from "../../daemon-client.ts";
import type { ExecResult, Probes } from "../probes.ts";

export type ExecScript = (argv: string[], opts?: Parameters<Probes["exec"]>[1]) => ExecResult | Promise<ExecResult>;

export interface FakeProbesOpts {
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
  links?: Record<string, string>;
  exec?: ExecScript;
  fetch?: Probes["fetch"];
  tray?: TrayClient;
  daemon?: Probes["daemon"];
  env?: Record<string, string>;
  home?: string;
  now?: Date;
  runRt?: Probes["runRt"];
}

export function fakeProbes(opts: FakeProbesOpts = {}): Probes & {
  calls: {
    exec: string[][];
    fetch: string[];
    tray: string[];
    writes: Record<string, string>;
    removed: string[];
    symlinks: Record<string, string>;
    modes: Record<string, number>;
  };
} {
  const files = { ...(opts.files ?? {}) };
  const dirs: Record<string, string[]> = { ...(opts.dirs ?? {}) };
  const links = { ...(opts.links ?? {}) };

  const calls = {
    exec: [] as string[][],
    fetch: [] as string[],
    tray: [] as string[],
    writes: {} as Record<string, string>,
    removed: [] as string[],
    symlinks: {} as Record<string, string>,
    modes: {} as Record<string, number>,
  };

  const defaultTray: TrayClient = async () => ({ status: 0, json: null });
  const tray = opts.tray ?? defaultTray;

  const probes: Probes = {
    async exec(argv, execOpts) {
      calls.exec.push(argv);
      if (opts.exec) return opts.exec(argv, execOpts);
      return { code: 0, stdout: "", stderr: "" };
    },

    exists(path) {
      return path in files || path in dirs || path in links;
    },

    readFile(path) {
      return files[path] ?? null;
    },

    readDir(path) {
      return dirs[path] ?? [];
    },

    readlink(path) {
      return links[path] ?? null;
    },

    writeFile(path, content, mode) {
      files[path] = content;
      calls.writes[path] = content;
      if (mode !== undefined) calls.modes[path] = mode;
    },

    removeFile(path) {
      // Real unlinkSync removes a symlink at `path` too — a fake that only
      // cleared `files` left `exists(path)` true after a
      // removeFile(p); symlink(t, p) repair, passing an "it was cleared"
      // assertion for the wrong reason.
      delete files[path];
      delete links[path];
      calls.removed.push(path);
    },

    removeDir(path) {
      // rm -rf semantics: every nested files/dirs/links entry under `path`
      // goes too, not just the `dirs[path]` key itself.
      const prefix = `${path}/`;
      delete dirs[path];
      for (const key of Object.keys(dirs)) if (key.startsWith(prefix)) delete dirs[key];
      for (const key of Object.keys(files)) if (key.startsWith(prefix)) delete files[key];
      for (const key of Object.keys(links)) if (key.startsWith(prefix)) delete links[key];
      calls.removed.push(path);
    },

    symlink(target, path) {
      links[path] = target;
      calls.symlinks[path] = target;
    },

    mkdirp(path, mode) {
      if (!(path in dirs)) dirs[path] = [];
      // A subsequent readDir(parent) must see the new dir, same as real mkdirSync.
      const parent = dirname(path);
      if (parent !== path) {
        const parentList = dirs[parent] ?? (dirs[parent] = []);
        const base = basename(path);
        if (!parentList.includes(base)) parentList.push(base);
      }
      if (mode !== undefined) calls.modes[path] = mode;
    },

    async fetch(url, init) {
      calls.fetch.push(url);
      if (opts.fetch) return opts.fetch(url, init);
      return { status: 0, body: "", headers: {} };
    },

    // The wrapper isn't itself generic, so TS can't match it structurally
    // against TrayClient's `<T>(...) => Promise<TrayReply<T>>` signature —
    // it's still exactly that signature at every call site since json stays
    // `unknown` either way.
    tray: (async (path, init) => {
      calls.tray.push(path);
      return tray(path, init);
    }) as TrayClient,

    async daemon(cmd, payload, timeoutMs) {
      if (opts.daemon) return opts.daemon(cmd, payload, timeoutMs);
      return null;
    },

    env: opts.env ?? {},

    home: opts.home ?? "/fake-home",

    now() {
      return opts.now ?? new Date("2026-01-01T00:00:00Z");
    },

    runRt:
      opts.runRt ??
      (async () => ({ code: 0, stdout: "", stderr: "" })),
  };

  return { ...probes, calls };
}

export function fakeTray(routes: Record<string, (body?: unknown) => { status: number; json: unknown }>): TrayClient {
  return (async (path, init = { method: "GET" }) => {
    const key = `${init.method} ${path}`;
    const handler = routes[key];
    if (!handler) return { status: 0, json: null };
    return handler(init.body);
  }) as TrayClient;
}

export const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
export const missing = (bin: string): ExecResult => ({ code: 127, stdout: "", stderr: `ENOENT: ${bin}` });
