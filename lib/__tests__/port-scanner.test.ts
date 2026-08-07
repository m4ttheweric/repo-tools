import { describe, expect, test } from "bun:test";
import {
  parseListeningLsof,
  parsePidValueMap,
  parseCwdMap,
  parseWorktreePorcelain,
  parseEtimeMs,
} from "../port-scanner.ts";

describe("parseListeningLsof", () => {
  test("parses IPv4 and IPv6 listeners and dedupes pid:port", () => {
    const output = [
      "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "node    12345 matt   23u  IPv4 0x1      0t0  TCP *:3000 (LISTEN)",
      "node    12345 matt   24u  IPv6 0x2      0t0  TCP [::1]:3000 (LISTEN)",
      "bun     67890 matt   11u  IPv4 0x3      0t0  TCP 127.0.0.1:9401 (LISTEN)",
    ].join("\n");

    const result = parseListeningLsof(output);
    expect(result).toEqual([
      { command: "node", pid: 12345, port: 3000 },
      { command: "bun", pid: 67890, port: 9401 },
    ]);
  });

  test("returns empty for header-only or empty output", () => {
    expect(parseListeningLsof("")).toEqual([]);
    expect(parseListeningLsof("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME")).toEqual([]);
  });

  test("skips lines without a LISTEN port", () => {
    const output = [
      "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "node    12345 matt   23u  IPv4 0x1      0t0  TCP 1.2.3.4:443 (ESTABLISHED)",
    ].join("\n");
    expect(parseListeningLsof(output)).toEqual([]);
  });
});

describe("parsePidValueMap", () => {
  test("maps pid to remainder of line, preserving spaces in values", () => {
    const output = [
      "  123 /Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      "  456 node",
      "  789    01-02:33:44",
    ].join("\n");

    const result = parsePidValueMap(output);
    expect(result.get(123)).toBe("/Applications/Visual Studio Code.app/Contents/MacOS/Electron");
    expect(result.get(456)).toBe("node");
    expect(result.get(789)).toBe("01-02:33:44");
  });

  test("ignores non-matching lines", () => {
    expect(parsePidValueMap("garbage\n\n").size).toBe(0);
  });
});

describe("parseCwdMap", () => {
  test("pairs p/n field lines into pid → cwd", () => {
    const output = "p123\nn/Users/matt/repos/foo\np456\nn/tmp/elsewhere\n";
    const result = parseCwdMap(output);
    expect(result.get(123)).toBe("/Users/matt/repos/foo");
    expect(result.get(456)).toBe("/tmp/elsewhere");
  });

  test("ignores non-path n lines and orphan n lines", () => {
    const output = "nrelative-not-a-path\np123\nnnot/absolute\n";
    expect(parseCwdMap(output).size).toBe(0);
  });
});

describe("parseWorktreePorcelain", () => {
  test("parses multiple worktrees with branches", () => {
    const output = [
      "worktree /Users/matt/repos/foo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /Users/matt/repos/foo-wt1",
      "HEAD def456",
      "branch refs/heads/feature/x",
      "",
    ].join("\n");

    expect(parseWorktreePorcelain(output)).toEqual([
      { path: "/Users/matt/repos/foo", branch: "main" },
      { path: "/Users/matt/repos/foo-wt1", branch: "feature/x" },
    ]);
  });

  test("omits detached worktrees (no branch line)", () => {
    const output = [
      "worktree /Users/matt/repos/foo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /Users/matt/repos/foo-detached",
      "HEAD def456",
      "detached",
      "",
    ].join("\n");

    expect(parseWorktreePorcelain(output)).toEqual([
      { path: "/Users/matt/repos/foo", branch: "main" },
    ]);
  });
});

describe("parseEtimeMs", () => {
  test("MM:SS", () => expect(parseEtimeMs("07:13")).toBe(433_000));
  test("HH:MM:SS", () => expect(parseEtimeMs("21:28:36")).toBe(77_316_000));
  test("DD-HH:MM:SS", () => expect(parseEtimeMs("2-03:14:22")).toBe(184_462_000));
  test("leading whitespace from ps padding", () => expect(parseEtimeMs("  00:01")).toBe(1000));

  // Null, not 0: an unreadable clock must not read as "just started", or a
  // long-running process would silently never cross the staleness threshold.
  test("the scanner's placeholder is unknown, not zero", () => {
    expect(parseEtimeMs("unknown")).toBeNull();
    expect(parseEtimeMs("")).toBeNull();
  });
});
