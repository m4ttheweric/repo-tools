/**
 * The home-snapshot daemon's most recent push outcome, written by the daemon
 * and read by the `home.backup` setup row.
 *
 * It lives under its OWN kv key, never `home-snapshot`/`state`: that row is
 * rewritten wholesale (`{ firstSeenDirty }`) on every commit cycle, so a
 * sibling field there would be clobbered within seconds and the probe would
 * report "never pushed" forever.
 *
 * It is diagnostic only. Git's own `refs/remotes/origin/<branch>` stays the
 * sole evidence a push completed — this record supplies the *why* behind a
 * push that is failing, which nothing else on the machine surfaces.
 */

import { existsSync } from "fs";
import type { Database } from "bun:sqlite";
import { getKvValue, getStateDb, setKvValue, stateDbPath } from "../state/index.ts";

/** Shared with lib/daemon/home-snapshot.ts's own `state` row: same namespace, different key, which is the whole point. Also the default `ns` below, so a snapshot instance keyed on some other namespace writes its record beside its own state row, not on top of home's. */
export const HOME_SNAPSHOT_NS = "home-snapshot";
export const HOME_PUSH_KEY = "last-push";

export interface HomePushRecord {
  /** Epoch ms of the attempt. */
  at: number;
  ok: boolean;
  /** Credential-redacted stderr of a failed attempt; absent on success. */
  error?: string;
}

function isHomePushRecord(value: unknown): value is HomePushRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<HomePushRecord>;
  return typeof record.at === "number" && Number.isFinite(record.at) && typeof record.ok === "boolean";
}

export function recordHomePush(db: Database, record: HomePushRecord, ns: string = HOME_SNAPSHOT_NS): void {
  setKvValue(ns, HOME_PUSH_KEY, record, db);
}

/**
 * Never opens state.db when the file is absent, and never throws: `rt verify`
 * runs in CI and mid-install, where a probe read must neither materialize the
 * database nor turn a missing record into an `error` row. No record means "no
 * recorded push", which is the correct reading on a machine whose daemon has
 * never run.
 */
export function readHomePushRecord(db?: Database, ns: string = HOME_SNAPSHOT_NS): HomePushRecord | null {
  try {
    const target = db ?? (existsSync(stateDbPath()) ? getStateDb() : null);
    if (!target) return null;
    const raw = getKvValue<unknown>(ns, HOME_PUSH_KEY, null, target);
    return isHomePushRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}
