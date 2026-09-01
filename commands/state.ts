/**
 * rt state -- backup/restore rt's own state.db (R055).
 *
 *   rt state backup [--json]
 *   rt state restore <copy> [--json]
 *
 * `backup` writes a stamped VACUUM INTO copy under stateBackupsDir() and
 * prunes copies past the retention window. `restore` overwrites the live
 * state.db from a stamped copy (by filename or absolute path) after an
 * integrity check on the source; run it with the daemon stopped.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import type { CommandContext } from "../lib/command-tree.ts";
import { isDaemonRunning } from "../lib/daemon-client.ts";
import {
  backupTo,
  closeStateDb,
  getStateDb,
  listStateBackups,
  pruneStateBackups,
  quickCheck,
  stampedBackupPath,
  stateBackupsDir,
  stateDbPath,
} from "../lib/state/index.ts";

function fail(msg: string): never {
  console.error(`rt state: ${msg}`);
  process.exit(1);
}

function copyArg(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("--"));
}

async function pickBackup(names: readonly string[]): Promise<string | null> {
  const { filterableSelect } = await import("../lib/pick-wrappers.ts");
  return filterableSelect({
    message: "Restore which state.db backup?",
    options: names.map((name) => ({ value: name, label: name })),
    stderr: true,
  });
}

/** The positional, or a TTY pick over existing stamped copies; the existing `fail` otherwise (no TTY, --json, RT_BATCH, or nothing to pick from). */
async function requireCopy(args: string[], usage: string): Promise<string> {
  const c = copyArg(args);
  if (c) return c;
  const names = listStateBackups();
  if (names.length > 0 && process.stdin.isTTY && !args.includes("--json") && !process.env.RT_BATCH) {
    const picked = await pickBackup(names);
    if (!picked) process.exit(0);
    return picked;
  }
  fail(usage);
}

export async function stateBackup(args: string[], _ctx: CommandContext = {}): Promise<void> {
  const json = args.includes("--json");
  const path = stampedBackupPath();
  backupTo(getStateDb(), path);
  const { removed } = pruneStateBackups();

  if (json) {
    console.log(JSON.stringify({ ok: true, path, pruned: removed }));
    return;
  }
  console.log(`rt state backup: wrote ${path}`);
  if (removed.length > 0) console.log(`rt state backup: pruned ${removed.length} old backup(s)`);
}

export async function stateRestore(args: string[], _ctx: CommandContext = {}): Promise<void> {
  const json = args.includes("--json");
  const force = args.includes("--force");

  // state.db is WAL-mode and shared live with the daemon: copyFileSync over
  // it plus deleting its -wal/-shm sidecars while the daemon holds it open
  // can corrupt the live db, not just this CLI's view of it. A deterministic
  // refusal, never an interactive prompt, so non-TTY/agent callers get a
  // clean nonzero exit instead of a hang.
  if (!force && (await isDaemonRunning())) {
    fail("the daemon is running; state.db is shared with it. Stop it first (rt daemon stop) or pass --force to override");
  }

  const copy = await requireCopy(args, "usage: rt state restore <copy> [--json]");

  const source = existsSync(copy) ? copy : join(stateBackupsDir(), copy);
  if (!existsSync(source)) fail(`backup not found: ${copy}`);

  const probe = new Database(source, { readonly: true });
  let problems: string[];
  try {
    problems = quickCheck(probe);
  } finally {
    probe.close();
  }
  if (problems.length > 0) fail(`${source} fails integrity check: ${problems.join("; ")}`);

  closeStateDb();
  const dest = stateDbPath();
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  for (const sidecar of [`${dest}-wal`, `${dest}-shm`]) {
    try {
      unlinkSync(sidecar);
    } catch {
      // sidecar absent: a plain copy (no WAL) leaves nothing to clean up
    }
  }

  if (json) {
    console.log(JSON.stringify({ ok: true, restored: dest, from: source }));
    return;
  }
  console.log(`rt state restore: restored state.db from ${source}`);
}
