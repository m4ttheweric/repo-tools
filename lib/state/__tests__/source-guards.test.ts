/**
 * RT-48 source-guards: the two invariants that would rot silently.
 *
 * 1. The six legacy JSON state files are RETIRED. state.db is the only
 *    writer of rt's cache/state now; the legacy names may survive exactly
 *    twice — as a `LEGACY_IMPORTS` registration key (the one-shot v0→v1
 *    reader) and in the `.json.migrated` rename that follows it. Any other
 *    live reference means some path is still reading or recreating a file
 *    that no longer carries the truth (spec "Migration & contention": a
 *    still-running old daemon recreating orphan JSON is a rollout hazard,
 *    not a supported code path).
 *
 * 2. The daemon opens (and if needed migrates) state.db BEFORE it binds
 *    either server. The one long transaction in this system is the legacy
 *    import, and the spec is explicit that it must land in startup, never
 *    in the event loop ("the daemon performs open+migrate during startup,
 *    BEFORE serving"). Statement order in one function is invisible to
 *    every other test, so it is pinned here.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** The six JSON files state.db replaced (spec "Store-by-store"). */
const LEGACY_STATE_FILES = [
  "branch-cache.json",
  "project-mrs.json",
  "discussions.json",
  "notifier-state.json",
  "events-cursors.json",
  "notify-queue.json",
];

/** Walk shipped .ts/.tsx sources (no tests, no node_modules, no dist). */
function walkSources(root: string, visit: (file: string, src: string) => void): void {
  if (!statSync(root).isDirectory()) {
    visit(root, readFileSync(root, "utf8"));
    return;
  }
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__tests__" || name === "dist") continue;
      walkSources(full, visit);
      continue;
    }
    if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
    if (name.endsWith(".test.ts")) continue;
    visit(full, readFileSync(full, "utf8"));
  }
}

const isComment = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line);

describe("legacy JSON state files are retired", () => {
  test("no shipped source references one outside a LEGACY_IMPORTS key or a .migrated rename", () => {
    const roots = [
      join(REPO_ROOT, "lib"),
      join(REPO_ROOT, "commands"),
      join(REPO_ROOT, "cli.ts"),
      join(REPO_ROOT, "scripts"),
      join(REPO_ROOT, "packages", "rt-client", "src"),
    ];
    // The two legitimate spellings: the importer registration key, and any
    // line dealing with the post-import `.migrated` sources.
    const allowed = [
      new RegExp(`^\\s*file:\\s*"(${LEGACY_STATE_FILES.join("|")})",?\\s*$`),
      /\.migrated/,
    ];

    const offenders: string[] = [];
    for (const root of roots) {
      walkSources(root, (file, src) => {
        src.split("\n").forEach((line, i) => {
          if (isComment(line)) return;
          if (!LEGACY_STATE_FILES.some((f) => line.includes(f))) return;
          if (allowed.some((re) => re.test(line))) return;
          offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        });
      });
    }
    expect(
      offenders,
      `Legacy JSON state files are read once at migration and never again:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("daemon startup opens state.db before serving", () => {
  test("openBranchCacheStore() precedes both server binds in runDaemon", () => {
    const src = readFileSync(join(REPO_ROOT, "lib", "daemon.ts"), "utf8");
    // startDaemon() itself is now just `await runDaemon()` (see "boot
    // failure is fatal" below — the catch-and-exit lives in runDaemon
    // itself); the real ordered startup sequence this test asserts on
    // lives in runDaemon() too.
    const start = src.indexOf("async function runDaemon(");
    expect(start).toBeGreaterThan(-1);

    const body = src.slice(start);
    const open = body.indexOf("openBranchCacheStore()");
    const clearArmed = body.indexOf("clearAllArmed()");
    const routed = body.indexOf("routedHandlers = buildRoutedHandlers(");
    const socket = body.indexOf("startSocketServer(");
    const api = body.indexOf("startApiServer(");

    expect(open).toBeGreaterThan(-1);
    expect(clearArmed).toBeGreaterThan(-1);
    expect(routed).toBeGreaterThan(-1);
    expect(socket).toBeGreaterThan(-1);
    expect(api).toBeGreaterThan(-1);
    // Spec "Migration & contention": the legacy import is the one long
    // transaction, so it blocks startup, never the serving event loop.
    expect(open).toBeLessThan(socket);
    expect(open).toBeLessThan(api);
    // No waiter outlives the daemon, so a stale armed_at must be cleared
    // before the socket listens, or an agent arming in the gap loses it.
    expect(clearArmed).toBeLessThan(socket);
    expect(clearArmed).toBeLessThan(api);
    // routedHandlers builds the chat handlers, which call getStateDb — so it
    // must land after the store opens; and before the binds, or a command can
    // arrive while routedHandlers is still undefined and fall through to the
    // switch that no longer owns it.
    expect(routed).toBeGreaterThan(open);
    expect(routed).toBeLessThan(socket);
    expect(routed).toBeLessThan(api);
  });
});

describe("boot failure is fatal for both fire-and-forget callers", () => {
  test("runDaemon is not exported — startDaemon is the only safe entry point", () => {
    const src = readFileSync(join(REPO_ROOT, "lib", "daemon.ts"), "utf8");
    expect(src).not.toContain("export async function runDaemon(");
    expect(src).not.toContain("export function runDaemon(");
  });

  test("runDaemon wraps its own body in try/catch and exits nonzero on failure; startDaemon just awaits it", () => {
    const src = readFileSync(join(REPO_ROOT, "lib", "daemon.ts"), "utf8");
    const runStart = src.indexOf("async function runDaemon(");
    const startDaemonStart = src.indexOf("export async function startDaemon(");
    expect(runStart).toBeGreaterThan(-1);
    expect(startDaemonStart).toBeGreaterThan(runStart);

    // Both real callers (cli.ts's --daemon entry, this file's own
    // import.meta.main guard) invoke startDaemon() fire-and-forget, and
    // startDaemon() is now just `await runDaemon()` — so the catch-and-exit
    // MUST live inside runDaemon() itself, or an unhandledRejection could
    // silently leave the daemon half-up (rt.sock possibly bound, nothing
    // past the failure ever wired). The booting-gated unhandledRejection
    // handler (installCrashHandlers) is only the backstop for whatever
    // still manages to slip past this try/catch.
    const runBody = src.slice(runStart, startDaemonStart);
    expect(runBody).toContain("catch");
    expect(runBody).toContain("process.exit(1)");

    const startDaemonBody = src.slice(startDaemonStart, startDaemonStart + 200);
    expect(startDaemonBody).toContain("await runDaemon()");
  });
});
