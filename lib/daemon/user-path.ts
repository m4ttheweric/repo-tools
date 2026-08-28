/**
 * Resolve the user's full PATH once at daemon startup.
 *
 * Strategy: a fast non-interactive `-lc` login shell (sources .zprofile, plus
 * an explicit NVM fallback) establishes the base PATH quickly and can't hang
 * on interactive-shell setup (compinit, OMZ, etc). A separate `-ilc`
 * interactive probe then layers in whatever only .zshrc/.bashrc export
 * (nvm's own PATH lines, ~/.local/bin, etc), unioned onto the base rather
 * than replacing it, so a slow or misbehaving interactive probe can never
 * regress the base PATH ... it can only fail to add to it.
 *
 * Both probes run through the injected `ProbeFn` seam so this module never
 * spawns a shell directly and stays unit-testable without a real subprocess.
 */

import { basename } from "path";
import type { Logger } from "pino";
import { getSetting } from "../settings/resolve.ts";

export type ProbeFn = (
  argv: [string, ...string[]],
  opts: { timeoutMs: number; env?: Record<string, string | undefined> },
) => Promise<string | null>;

const BASE_TIMEOUT_MS = 5_000;
const OVERLAY_TIMEOUT_MS = 3_000;
const KILL_GRACE_MS = 500;

/** Default probe: a detached (own process-group) Bun.spawn whose whole group is
 *  SIGTERM'd then SIGKILL'd at the deadline, raced so a hung shell (or a hung
 *  grandchild it spawned) can never block boot past the timeout. */
const runProbe: ProbeFn = async (argv, opts) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      detached: true,
      env: opts.env ?? { ...process.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return null;
  }
  proc.unref();
  const pid = proc.pid;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const term = setTimeout(() => {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* group already gone */
    }
    killTimer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }, KILL_GRACE_MS);
    killTimer.unref?.();
  }, opts.timeoutMs);
  const captured: Promise<string | null> = (async () => {
    try {
      const [out] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);
      return out;
    } catch {
      return null;
    }
  })();
  let deadlineTimer: ReturnType<typeof setTimeout>;
  const deadline: Promise<null> = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => resolve(null), opts.timeoutMs + KILL_GRACE_MS + 250);
  });
  try {
    return await Promise.race([captured, deadline]);
  } finally {
    clearTimeout(term);
    if (killTimer) clearTimeout(killTimer);
    clearTimeout(deadlineTimer!);
  }
};

function validateBase(
  raw: string | null,
  baseline: string,
): { path: string; source: "probe" | "baseline"; reason?: string } {
  if (raw === null) return { path: baseline, source: "baseline", reason: "killed-or-empty" };
  const v = raw.trim();
  if (v.length === 0) return { path: baseline, source: "baseline", reason: "empty" };
  if (/\s/.test(v)) return { path: baseline, source: "baseline", reason: "whitespace" };
  if (v.split(":").filter(Boolean).length < 2) return { path: baseline, source: "baseline", reason: "too-few-segments" };
  if (v === baseline) return { path: baseline, source: "baseline", reason: "equals-baseline" };
  return { path: v, source: "probe" };
}

/** Overlay contributes only well-formed absolute dirs; anything else yields []. */
function absoluteDirsOf(raw: string | null): string[] {
  if (raw === null) return [];
  const v = raw.trim();
  if (v.length === 0 || /\s/.test(v)) return [];
  return v.split(":").filter((d) => d.startsWith("/"));
}

function unionAppend(base: string, extra: string[]): string {
  const have = new Set(base.split(":").filter(Boolean));
  const add = extra.filter((d) => !have.has(d));
  return add.length === 0 ? base : [base, ...add].join(":");
}

/** Which of `names` is a non-empty file on `pathValue`, keyed `has<Name>`. */
export function probeTools(pathValue: string, names: string[]): Record<string, boolean> {
  const entries = pathValue.split(":").filter((p) => p.length > 0);
  const probed: Record<string, boolean> = {};
  for (const name of names) {
    probed[`has${name[0]!.toUpperCase()}${name.slice(1)}`] = entries.some((p) => {
      try {
        return Bun.file(`${p}/${name}`).size > 0;
      } catch {
        return false;
      }
    });
  }
  return probed;
}

export async function resolveUserPath(log: Logger, probe: ProbeFn = runProbe): Promise<string> {
  const baseline = process.env.PATH ?? "";

  const override = getSetting<string>("rt.daemonPath").value;
  let result: string;
  let source: string;

  if (typeof override === "string" && override.trim().length > 0) {
    result = override.trim();
    source = "override";
  } else {
    const shell = process.env.SHELL ?? "/bin/zsh";
    const isFish = basename(shell) === "fish";
    const baseArgv: [string, ...string[]] = isFish
      ? [shell, "-lc", "string join : $PATH"]
      : [
          shell,
          "-lc",
          `{ [ -s "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" ] && . "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1; }; printf %s "$PATH"`,
        ];
    const base = validateBase(await probe(baseArgv, { timeoutMs: BASE_TIMEOUT_MS }), baseline);
    result = base.path;
    source = base.source;
    if (base.reason) log.warn({ reason: base.reason }, "PATH base probe unusable; kept baseline");

    const ovArgv: [string, ...string[]] = isFish ? [shell, "-ilc", "string join : $PATH"] : [shell, "-ilc", "echo $PATH"];
    const ovRaw = await probe(ovArgv, { timeoutMs: OVERLAY_TIMEOUT_MS, env: { ...process.env, TERM: "dumb" } });
    const extra = absoluteDirsOf(ovRaw);
    if (extra.length === 0) {
      // Warn on BOTH timeout (null) and garbage (non-null but no usable
      // absolute dirs) ... the ruling says timeout OR garbage.
      log.warn("PATH interactive overlay skipped (timed out or no usable dirs)");
    } else {
      const before = result;
      result = unionAppend(result, extra);
      if (result !== before) source += "+overlay";
    }
  }

  const probed = probeTools(result, ["node", "git", "bun", "pnpm"]);
  const missing = Object.entries(probed)
    .filter(([, v]) => !v)
    .map(([k]) => k.replace(/^has/, "").toLowerCase());
  if (missing.length > 0) log.warn({ missing }, "PATH missing required tools; set rt.daemonPath to override");
  log.info({ source, entries: result.split(":").length, ...probed }, "PATH resolved");
  return result;
}
