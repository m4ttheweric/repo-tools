/**
 * Auto-fix log + notes file I/O.
 *
 * `~/.rt/<repo>/auto-fix-log.json` — append-only ring of last 100 attempts.
 * `~/.rt/<repo>/auto-fix-notes/<branch>-<sha>.md` — durable per-attempt notes
 * for skipped/error/rejected outcomes (so users can inspect why later).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type AttemptOutcome =
  | "fixed"
  | "skipped"
  | "error"
  | "rejected_diff";

export interface AutoFixLogEntry {
  branch:      string;
  sha:         string;
  attemptedAt: number;
  outcome:     AttemptOutcome;
  durationMs:  number;
  commitSha?:  string;
  reason?:     string;
}

const RING_MAX = 100;

function rtDir(): string {
  return join(process.env.HOME ?? homedir(), ".rt");
}

export function autoFixLogPath(repoName: string): string {
  return join(rtDir(), repoName, "auto-fix-log.json");
}

export function autoFixNotesDir(repoName: string): string {
  return join(rtDir(), repoName, "auto-fix-notes");
}

export function autoFixNotesPath(repoName: string, branch: string, sha: string): string {
  const safeBranch = branch.replace(/\//g, "-");
  return join(autoFixNotesDir(repoName), `${safeBranch}-${sha}.md`);
}

export function readLog(repoName: string): AutoFixLogEntry[] {
  const path = autoFixLogPath(repoName);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function appendLogEntry(repoName: string, entry: AutoFixLogEntry): void {
  mkdirSync(join(rtDir(), repoName), { recursive: true });
  const log = readLog(repoName);
  log.push(entry);
  const trimmed = log.length > RING_MAX ? log.slice(log.length - RING_MAX) : log;
  writeFileSync(autoFixLogPath(repoName), JSON.stringify(trimmed, null, 2));
}

/** Count attempts that count toward the budget (fixed, error, rejected_diff). Skipped does not. */
export function countAttemptsForSha(repoName: string, branch: string, sha: string): number {
  const log = readLog(repoName);
  return log.filter(e =>
    e.branch === branch &&
    e.sha    === sha    &&
    (e.outcome === "fixed" || e.outcome === "error" || e.outcome === "rejected_diff")
  ).length;
}

export function writeNotes(repoName: string, branch: string, sha: string, body: string): void {
  mkdirSync(autoFixNotesDir(repoName), { recursive: true });
  writeFileSync(autoFixNotesPath(repoName, branch, sha), body);
}

export function readNotes(repoName: string, branch: string, sha: string): string | null {
  const path = autoFixNotesPath(repoName, branch, sha);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
