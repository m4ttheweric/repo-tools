/**
 * Per-repo on-disk lock for auto-fix.
 *
 * Path: ~/.rt/<repo>/auto-fix.lock. Holds the live attempt's metadata. If the
 * recorded PID is not alive (daemon was killed mid-run), the lock is treated
 * as stale and acquireLock will replace it.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

interface LockBody {
  branch:    string;
  sha:       string;
  pid:       number;
  startedAt: number;
}

function rtDir(): string {
  return join(process.env.HOME ?? homedir(), ".rt");
}

export function autoFixLockPath(repoName: string): string {
  return join(rtDir(), repoName, "auto-fix.lock");
}

function readLock(repoName: string): LockBody | null {
  const path = autoFixLockPath(repoName);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof raw?.branch === "string" &&
      typeof raw?.sha === "string" &&
      typeof raw?.pid === "number" &&
      typeof raw?.startedAt === "number"
    ) return raw;
    return null;
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isLockHeld(repoName: string): boolean {
  const lock = readLock(repoName);
  if (!lock) return false;
  return pidIsAlive(lock.pid);
}

/**
 * Try to acquire the lock. Returns true on success, false if a live lock
 * already exists. Stale locks (dead PID) are silently replaced.
 */
export function acquireLock(
  repoName: string,
  meta: { branch: string; sha: string },
): boolean {
  const existing = readLock(repoName);
  if (existing && pidIsAlive(existing.pid)) return false;

  mkdirSync(join(rtDir(), repoName), { recursive: true });
  const body: LockBody = {
    branch:    meta.branch,
    sha:       meta.sha,
    pid:       process.pid,
    startedAt: Date.now(),
  };
  writeFileSync(autoFixLockPath(repoName), JSON.stringify(body, null, 2));
  return true;
}

export function releaseLock(repoName: string): void {
  const path = autoFixLockPath(repoName);
  if (!existsSync(path)) return;
  try { unlinkSync(path); } catch { /* */ }
}
