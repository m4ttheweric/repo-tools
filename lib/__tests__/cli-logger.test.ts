import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { installCliLogging, logCommand } from "../cli-logger.ts";
import { logsDir } from "../rt-paths.ts";
import { encodeCode } from "../team/invite-crypto.ts";
import { persistOrWarn, setBusyLogSink } from "../state/busy.ts";

/**
 * Exercises the REAL logCommand write path (fake HOME, from test-setup.ts's
 * preload — never the developer's real ~/.mattstack/rt/logs), not a mocked
 * seam: this is the gap the store-level canary test couldn't cover, since
 * that one only checked a command's stdout, never the on-disk CLI log every
 * command writes to regardless of outcome.
 */
function readTodaysCliLogLines(): string[] {
  const dir = logsDir();
  const file = readdirSync(dir).find((f) => f.startsWith("cli.") && f.endsWith(".log"));
  if (!file) throw new Error("expected today's cli log file to exist after logCommand()");
  return readFileSync(join(dir, file), "utf8").trim().split("\n").filter(Boolean);
}

describe("logCommand: rt secrets set|rotate never reaches disk with a value attached", () => {
  test("a canary trailing 'rt secrets set <domain> <key>' is redacted in the on-disk line", () => {
    const CANARY = "sk_super_secret_canary_never_on_disk";

    logCommand({
      command: "rt secrets set",
      args: ["rt", "gitlabToken", CANARY],
      cwd: "/tmp",
      durationMs: 1,
      outcome: "ok",
    });

    const lines = readTodaysCliLogLines();
    const line = lines.at(-1)!;
    expect(line).not.toContain(CANARY);
    expect(line).toContain("gitlabToken");
    expect(JSON.parse(line).args).toEqual(["rt", "gitlabToken", "[redacted]"]);
  });

  test("the same holds for rotate, and for an error outcome (the crash/exit path)", () => {
    const CANARY = "glpat_rotate_canary_never_on_disk";

    logCommand({
      command: "rt secrets rotate",
      args: ["board", "slackToken", CANARY],
      cwd: "/tmp",
      durationMs: 1,
      outcome: "error",
      error: "boom",
    });

    const lines = readTodaysCliLogLines();
    const line = lines.at(-1)!;
    expect(line).not.toContain(CANARY);
    expect(JSON.parse(line).args).toEqual(["board", "slackToken", "[redacted]"]);
  });
});

describe("logCommand: an rt team join invite code never reaches disk, even though the command refuses the run", () => {
  test("a live, real-shaped code — dispatch()'s actual call shape (command carries 'rt team join', args is just the trailing code) — is redacted in the on-disk line", () => {
    const CANARY = encodeCode("0102030405060708090a0b0c0d0e0f10", new Uint8Array(32).fill(7));

    logCommand({
      command: "rt team join",
      args: [CANARY],
      cwd: "/tmp",
      durationMs: 1,
      outcome: "error",
      error: "code-on-argv",
    });

    const lines = readTodaysCliLogLines();
    const line = lines.at(-1)!;
    expect(line).not.toContain(CANARY);
    expect(JSON.parse(line).args).toEqual(["[redacted]"]);
  });

  test("the code survives even with a flag alongside it, and a real flag is left alone", () => {
    const CANARY = encodeCode("1112131415161718191a1b1c1d1e1f10", new Uint8Array(32).fill(9));

    logCommand({
      command: "rt team join",
      args: [CANARY, "--dry-run"],
      cwd: "/tmp",
      durationMs: 1,
      outcome: "error",
      error: "code-on-argv",
    });

    const lines = readTodaysCliLogLines();
    const line = lines.at(-1)!;
    expect(line).not.toContain(CANARY);
    expect(JSON.parse(line).args).toEqual(["[redacted]", "--dry-run"]);
  });
});

describe("R052: installCliLogging routes lib/state/busy.ts's warnings onto the cli surface", () => {
  test("a busy write inside this process lands in cli.<date>.log, not the daemon surface", () => {
    installCliLogging(["rt", "some-command"]);

    try {
      persistOrWarn("mymodule", () => {
        const e = new Error("database is locked");
        (e as { code?: string }).code = "SQLITE_BUSY";
        throw e;
      }, { canary: "cli-busy-sink-canary" });

      const lines = readTodaysCliLogLines();
      const line = lines.at(-1)!;
      const parsed = JSON.parse(line);
      expect(parsed.level).toBe("warn");
      expect(parsed.module).toBe("mymodule");
      expect(parsed.canary).toBe("cli-busy-sink-canary");
    } finally {
      setBusyLogSink(null); // don't leak this sink into later test files in the same process, even on assertion failure
    }
  });
});
