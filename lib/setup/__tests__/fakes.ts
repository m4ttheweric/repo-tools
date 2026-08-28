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
  /** Explicit fileSize() overrides, keyed by the queried path — for simulating a large binary without storing megabytes of fake content. */
  sizes?: Record<string, number>;
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

  // Resolves through `links` the way real existsSync/statSync do: a symlink
  // whose target isn't itself a tracked file/dir (or another link) is
  // dangling and does NOT exist, even though the link entry itself is
  // present. Depth-capped against a link cycle, which real fs would ELOOP on.
  function resolveThroughLinks(path: string, depth = 0): string | null {
    if (depth > 10) return null;
    const target = links[path];
    if (target === undefined) return path in files || path in dirs ? path : null;
    return resolveThroughLinks(target, depth + 1);
  }

  const probes: Probes = {
    async exec(argv, execOpts) {
      calls.exec.push(argv);
      if (opts.exec) return opts.exec(argv, execOpts);
      return { code: 0, stdout: "", stderr: "" };
    },

    exists(path) {
      return resolveThroughLinks(path) !== null;
    },

    fileSize(path) {
      const override = opts.sizes?.[path];
      if (override !== undefined) return override;
      const resolved = resolveThroughLinks(path);
      if (resolved === null || resolved in dirs) return null; // dangling, or a directory — never a file size
      return Buffer.byteLength(files[resolved] ?? "", "utf8");
    },

    readFile(path) {
      return files[path] ?? null;
    },

    // Mirrors the real bounded (4096-byte) prefix read, through `links`
    // exactly like fileSize does -- a symlinked fixture (e.g. `p.symlink`
    // registering an rt bundle target) must resolve here too, not just for
    // real files planted via `files`.
    readPrefix(path) {
      const resolved = resolveThroughLinks(path);
      if (resolved === null || resolved in dirs) return null;
      return (files[resolved] ?? "").slice(0, 4096);
    },

    readDir(path) {
      // A copy, not the live array: real readdirSync snapshots the directory
      // at call time, so a caller iterating the result while also removing
      // entries (e.g. reconcile()) must not see the list mutate under it.
      return [...(dirs[path] ?? [])];
    },

    readlink(path) {
      return links[path] ?? null;
    },

    writeFile(path, content, mode) {
      files[path] = content;
      calls.writes[path] = content;
      if (mode !== undefined) calls.modes[path] = mode;
      // Mirrors real writeFileSync: the new entry must show up in a
      // subsequent readDir(parent), same as mkdirp does for child dirs.
      const parent = dirname(path);
      const parentList = dirs[parent] ?? (dirs[parent] = []);
      const base = basename(path);
      if (!parentList.includes(base)) parentList.push(base);
    },

    chmod(path, mode) {
      calls.modes[path] = mode;
    },

    removeFile(path) {
      // Real unlinkSync removes a symlink at `path` too — a fake that only
      // cleared `files` left `exists(path)` true after a
      // removeFile(p); symlink(t, p) repair, passing an "it was cleared"
      // assertion for the wrong reason.
      delete files[path];
      delete links[path];
      const parent = dirname(path);
      const parentList = dirs[parent];
      if (parentList) {
        const base = basename(path);
        const i = parentList.indexOf(base);
        if (i >= 0) parentList.splice(i, 1);
      }
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
      // Mirrors real symlinkSync: the new entry must show up in a subsequent
      // readDir(parent), same as writeFile and mkdirp do for their entries.
      const parent = dirname(path);
      const parentList = dirs[parent] ?? (dirs[parent] = []);
      const base = basename(path);
      if (!parentList.includes(base)) parentList.push(base);
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

/**
 * Simulates a REACHABLE app: an unregistered route answers 404, matching
 * real `trayRequest` (lib/daemon-client.ts), which returns status 0 only for
 * a transport failure (no socket — nobody home) and 404 for a route the app
 * genuinely doesn't have. A fake that answered 0 for both let a step pointed
 * at a wrong/stale tray path test green by reading as "app not running"
 * instead of the real "app running, route doesn't exist" — use
 * `fakeProbes({ home })`'s own bare default (no `tray` option) to simulate
 * an actually-unreachable app.
 */
export function fakeTray(routes: Record<string, (body?: unknown) => { status: number; json: unknown }>): TrayClient {
  return (async (path, init = { method: "GET" }) => {
    const key = `${init.method} ${path}`;
    const handler = routes[key];
    if (!handler) return { status: 404, json: null };
    return handler(init.body);
  }) as TrayClient;
}

export const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
export const missing = (bin: string): ExecResult => ({ code: 127, stdout: "", stderr: `ENOENT: ${bin}` });
