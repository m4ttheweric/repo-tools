/**
 * CLI command logger -- automatic structured logging for every rt command invocation.
 *
 * Writes JSON lines to ~/.mattstack/rt/logs/cli.YYYY-MM-DD.log with daily rotation
 * and 14-day retention. Designed to be zero-cost to callers: logging never
 * throws, never blocks the command, and requires no per-module code.
 *
 * Wired into the command-tree dispatcher so new modules get logging for free.
 */

import { openSync, writeSync, closeSync, readdirSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { logsDir } from "./rt-paths.ts";
import { setBusyLogSink } from "./state/busy.ts";

const RETENTION_DAYS = 14;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function logPath(): string {
  return join(logsDir(), `cli.${today()}.log`);
}

function pruneOldLogs(): void {
  try {
    const dir = logsDir();
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith("cli.") || !f.endsWith(".log")) continue;
      const match = f.match(/^cli\.(\d{4}-\d{2}-\d{2})\.log$/);
      if (!match) continue;
      const fileDate = new Date(match[1]!).getTime();
      if (fileDate < cutoff) {
        try { unlinkSync(join(dir, f)); } catch { /* best-effort */ }
      }
    }
  } catch { /* best-effort */ }
}

let hasPruned = false;

interface CommandLog {
  command: string;
  args: string[];
  cwd: string;
  repo?: string;
  durationMs: number;
  outcome: "ok" | "error" | "cancelled";
  error?: string;
  stack?: string;
  exitCode?: number;
}

const SECRETS_WRITE_VERBS = new Set(["set", "rotate"]);

/**
 * `rt secrets set|rotate <domain> <key>` never puts the value on argv by
 * design (commands/secrets.ts prompts or reads stdin) — but this is defense
 * in depth for any invocation that still carries a trailing token there
 * (an old habit, a stray positional), so anything past `<domain> <key>` is
 * redacted regardless of how it got there. Two shapes call this: the leaf
 * `rest` args (dispatch's tree walk already consumed the "secrets set"
 * prefix, so `command` carries that context instead) and the full raw argv
 * seeded before dispatch resolves anything (the prefix is still IN the
 * array).
 */
function redactSecretsWriteTail(args: string[], command?: string): string[] {
  if (command && /(?:^|\s)secrets (?:set|rotate)$/.test(command)) {
    return args.map((a, i) => (i < 2 ? a : "[redacted]"));
  }

  for (let i = 0; i + 1 < args.length; i++) {
    if (args[i] === "secrets" && SECRETS_WRITE_VERBS.has(args[i + 1]!)) {
      return args.map((a, idx) => (idx <= i + 3 ? a : "[redacted]"));
    }
  }
  return args;
}

/** The unmistakable prefix of a pasted age private key — never a legitimate flag or value for anything else. Matched command-independently: a key pasted where it never belongs (a positional arg) is still a key regardless of which command it landed under. */
const AGE_PRIVATE_KEY_PREFIX = "AGE-SECRET-KEY-1";

/**
 * `encodeCode`'s exact output shape (lib/team/invite-crypto.ts): Crockford
 * base32 (no I/L/O/U) in dash-separated groups. Matched command-independently
 * — a live, still-redeemable invite code is exactly the kind of secret that
 * ends up as a stray positional wherever a user pastes it, not just under
 * `team join`.
 */
const INVITE_CODE_PATTERN = /^[0-9A-HJKMNPQRSTVWXYZ]{2,5}(-[0-9A-HJKMNPQRSTVWXYZ]{2,5}){3,}$/i;

const TEAM_JOIN_FLAGS = new Set(["--dry-run", "--json"]);

/**
 * `rt team join` never wants an argv code at all (`commands/team.ts` refuses
 * the run with `code-on-argv`) — but the refusal happens AFTER this same
 * argv already reached `logCommand`, so anything positional under `team
 * join` is redacted regardless, the same defense-in-depth `redactSecretsWriteTail`
 * applies to `secrets set|rotate`. `INVITE_CODE_PATTERN` above is the
 * command-independent backstop; this is the command-aware one for a token
 * that doesn't happen to match the code's exact shape.
 */
function redactTeamJoinTail(args: string[], command?: string): string[] {
  if (command && /(?:^|\s)team join$/.test(command)) {
    return args.map((a) => (TEAM_JOIN_FLAGS.has(a) ? a : "[redacted]"));
  }

  for (let i = 0; i + 1 < args.length; i++) {
    if (args[i] === "team" && args[i + 1] === "join") {
      return args.map((a, idx) => (idx <= i + 1 || TEAM_JOIN_FLAGS.has(a) ? a : "[redacted]"));
    }
  }
  return args;
}

/**
 * Returns a copy of args with the value following any `--reason` flag
 * replaced by "[redacted]" (also handles the `--reason=value` form), any
 * arg starting with `AGE-SECRET-KEY-1` replaced outright (defense in depth
 * for a pasted age private key — see commands/home.ts's `homeKeyImport`
 * guard, which refuses the command but this must still keep the raw key
 * out of the log even if some other path ever lets one through), any
 * code-shaped token (`INVITE_CODE_PATTERN`), plus anything past `secrets
 * set|rotate <domain> <key>` or `team join` (see redactSecretsWriteTail /
 * redactTeamJoinTail). Reason text is free-form and often sensitive (e.g.
 * `rt sdm connect`), so it must never reach the on-disk CLI log. This only
 * affects what gets logged -- the real args passed to command handlers are
 * never touched.
 */
export function redactSensitiveArgs(args: string[], command?: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--reason") {
      result.push(arg);
      if (i + 1 < args.length) {
        result.push("[redacted]");
        i++;
      }
      continue;
    }
    if (arg.startsWith("--reason=")) {
      result.push("--reason=[redacted]");
      continue;
    }
    if (arg.startsWith(AGE_PRIVATE_KEY_PREFIX)) {
      result.push("[redacted]");
      continue;
    }
    if (INVITE_CODE_PATTERN.test(arg)) {
      result.push("[redacted]");
      continue;
    }
    result.push(arg);
  }
  return redactTeamJoinTail(redactSecretsWriteTail(result, command), command);
}

export function logCommand(entry: CommandLog): void {
  finalized = true;
  try {
    const dir = logsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const line = JSON.stringify({
      time: new Date().toISOString(),
      ...entry,
      args: redactSensitiveArgs(entry.args, entry.command),
    }) + "\n";

    const fd = openSync(logPath(), "a");
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }

    if (!hasPruned) {
      hasPruned = true;
      pruneOldLogs();
    }
  } catch { /* logging must never break a command */ }
}

// ─── Invocation-level coverage ───────────────────────────────────────────────
// dispatch() logs the happy path and thrown errors, but ~100 command paths
// terminate via process.exit() and never return to it. The exit hook below
// writes the record for those, so every invocation is logged no matter how
// it ends. `finalized` prevents double-writes when dispatch already logged.

let current: { command: string; args: string[]; t0: number } | null = null;
let finalized = false;

/**
 * A single structured log line on the cli surface, outside the per-command
 * CommandLog shape logCommand() writes (R052: lib/state/busy.ts's injected
 * sink, for a busy-write warning hit inside a CLI process rather than the
 * daemon).
 */
function writeCliLogLine(level: "warn" | "error", module: string, message: string, context: Record<string, unknown>): void {
  try {
    const dir = logsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ time: new Date().toISOString(), level, module, msg: message, ...context }) + "\n";
    const fd = openSync(logPath(), "a");
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  } catch { /* logging must never break a command */ }
}

/** Called by dispatch() once the command label is resolved. */
export function beginCommand(command: string, args: string[]): void {
  if (current) {
    current.command = command;
    current.args = args;
  }
}

/**
 * Install process-level hooks: an exit hook that records any invocation not
 * already logged (captures every process.exit() path), plus crash handlers
 * that persist uncaught exception / rejection stacks. Call ONCE at CLI entry,
 * never for the --daemon path (the daemon has its own pino crash handlers).
 */
export function installCliLogging(argv: string[]): void {
  // R052: a busy write inside this CLI process (rt run enrichment, rt repos
  // locate) now lands on THIS surface (cli.<date>.log), not the daemon's --
  // lib/state/busy.ts otherwise defaults every caller to getDaemonLogger().
  setBusyLogSink({
    warn: (module, context, message) => writeCliLogLine("warn", module, message, context),
    error: (module, context, message) => writeCliLogLine("error", module, message, context),
  });

  // Redact before joining: this seeds `current.command` for the window before
  // beginCommand() runs, so a crash in that window must not bake --reason
  // text into the on-disk log via the joined command string.
  const safeArgv = redactSensitiveArgs(argv);
  current = {
    command: safeArgv.length ? safeArgv.join(" ") : "(picker)",
    args: [],
    t0: Date.now(),
  };

  process.on("exit", (code) => {
    if (finalized || !current) return;
    logCommand({
      command: current.command,
      args: current.args,
      cwd: process.cwd(),
      durationMs: Date.now() - current.t0,
      outcome: code === 0 ? "ok" : code === 130 ? "cancelled" : "error",
      exitCode: code,
    });
  });

  const crash = (kind: string) => (err: unknown) => {
    if (!finalized && current) {
      logCommand({
        command: current.command,
        args: current.args,
        cwd: process.cwd(),
        durationMs: Date.now() - current.t0,
        outcome: "error",
        error: `${kind}: ${err instanceof Error ? err.message : String(err)}`,
        stack: err instanceof Error ? err.stack : undefined,
        exitCode: 1,
      });
    }
    // Preserve default behavior: print the failure and exit nonzero.
    console.error(err);
    process.exit(1);
  };
  process.on("uncaughtException", crash("uncaughtException"));
  process.on("unhandledRejection", crash("unhandledRejection"));
}
