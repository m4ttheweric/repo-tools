import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpHome = mkdtempSync(join(tmpdir(), "rt-auto-fix-log-"));
process.env.HOME = tmpHome;

const {
  appendLogEntry, readLog, autoFixLogPath,
  writeNotes, readNotes, autoFixNotesPath, autoFixNotesDir,
  countAttemptsForSha,
} = await import("../auto-fix-log.ts");

const REPO = "test-repo";

afterEach(() => {
  try { rmSync(join(tmpHome, ".rt", REPO), { recursive: true, force: true }); } catch { /* */ }
});

describe("auto-fix-log entries", () => {
  test("autoFixLogPath is ~/.rt/<repo>/auto-fix-log.json", () => {
    expect(autoFixLogPath(REPO)).toBe(join(tmpHome, ".rt", REPO, "auto-fix-log.json"));
  });

  test("readLog returns [] when file is missing", () => {
    expect(readLog(REPO)).toEqual([]);
  });

  test("appendLogEntry then readLog returns the entry", () => {
    const entry = {
      branch: "feat/x",
      sha: "abc123",
      attemptedAt: 1700000000000,
      outcome: "fixed" as const,
      durationMs: 30000,
      commitSha: "def456",
    };
    appendLogEntry(REPO, entry);
    expect(readLog(REPO)).toEqual([entry]);
  });

  test("appendLogEntry rings out at 100 entries", () => {
    for (let i = 0; i < 105; i++) {
      appendLogEntry(REPO, {
        branch: "feat/x", sha: `sha${i}`, attemptedAt: i,
        outcome: "skipped" as const, durationMs: 10,
      });
    }
    const log = readLog(REPO);
    expect(log.length).toBe(100);
    expect(log[0]?.sha).toBe("sha5");
    expect(log[99]?.sha).toBe("sha104");
  });

  test("countAttemptsForSha counts only counted outcomes (fixed/error/rejected_diff)", () => {
    appendLogEntry(REPO, { branch: "feat/x", sha: "abc", attemptedAt: 1, outcome: "fixed",         durationMs: 10 });
    appendLogEntry(REPO, { branch: "feat/x", sha: "abc", attemptedAt: 2, outcome: "skipped",       durationMs: 10 });
    appendLogEntry(REPO, { branch: "feat/x", sha: "abc", attemptedAt: 3, outcome: "error",         durationMs: 10 });
    appendLogEntry(REPO, { branch: "feat/x", sha: "abc", attemptedAt: 4, outcome: "rejected_diff", durationMs: 10 });
    appendLogEntry(REPO, { branch: "feat/x", sha: "xyz", attemptedAt: 5, outcome: "fixed",         durationMs: 10 });
    expect(countAttemptsForSha(REPO, "feat/x", "abc")).toBe(3);
    expect(countAttemptsForSha(REPO, "feat/x", "xyz")).toBe(1);
    expect(countAttemptsForSha(REPO, "feat/y", "abc")).toBe(0);
  });
});

describe("auto-fix-log notes", () => {
  test("autoFixNotesDir is ~/.rt/<repo>/auto-fix-notes/", () => {
    expect(autoFixNotesDir(REPO)).toBe(join(tmpHome, ".rt", REPO, "auto-fix-notes"));
  });

  test("autoFixNotesPath uses <branch>-<short-sha>.md (slashes in branch replaced)", () => {
    expect(autoFixNotesPath(REPO, "feat/x", "abc12345")).toBe(
      join(tmpHome, ".rt", REPO, "auto-fix-notes", "feat-x-abc12345.md"),
    );
  });

  test("writeNotes then readNotes round-trips", () => {
    writeNotes(REPO, "feat/x", "abc12345", "the agent said no\n");
    expect(readNotes(REPO, "feat/x", "abc12345")).toBe("the agent said no\n");
  });

  test("readNotes returns null when file missing", () => {
    expect(readNotes(REPO, "feat/x", "missing")).toBeNull();
  });
});
