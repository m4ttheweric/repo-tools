import { describe, expect, test } from "bun:test";
import { buildClaudeArgv, buildPaneCommand, isValidSessionUuid, shellSingleQuote } from "../agent-argv.ts";

const UUID = "6e225e74-4cb7-4aea-8807-6aa9011d4112";

describe("isValidSessionUuid", () => {
  test("accepts a v4 uuid, rejects the spike footguns", () => {
    expect(isValidSessionUuid(UUID)).toBe(true);
    expect(isValidSessionUuid("")).toBe(false);
    expect(isValidSessionUuid("ag-12345678")).toBe(false);
    expect(isValidSessionUuid("6E225E74-4CB7-4AEA-8807-6AA9011D4112")).toBe(true);
  });
});

describe("buildClaudeArgv", () => {
  const bins = { claude: "/abs/claude", cswap: "/abs/cswap" };

  test("plain start, pane surface", () => {
    expect(buildClaudeArgv({ session: { kind: "start", sessionId: UUID }, headless: false }, bins))
      .toEqual(["/abs/claude", "--session-id", UUID]);
  });

  test("all knobs, headless start with prompt", () => {
    expect(buildClaudeArgv({
      account: "a@b.c", model: "haiku", effort: "low", extraArgs: "--permission-mode plan",
      session: { kind: "start", sessionId: UUID }, headless: true, prompt: "do it",
    }, bins)).toEqual([
      "/abs/cswap", "run", "a@b.c", "--",
      "-p", "--output-format", "json",
      "--model", "haiku", "--effort", "low", "--session-id", UUID,
      "--permission-mode", "plan", "do it",
    ]);
  });

  test("resume never emits --session-id", () => {
    const argv = buildClaudeArgv({ session: { kind: "resume", sessionId: UUID }, headless: true, prompt: "q" }, bins);
    expect(argv).toEqual(["/abs/claude", "-p", "--output-format", "json", "--resume", UUID, "q"]);
    expect(argv).not.toContain("--session-id");
  });

  test("invalid uuid throws before any argv exists", () => {
    expect(() => buildClaudeArgv({ session: { kind: "start", sessionId: "" }, headless: false }, bins)).toThrow(/session uuid/);
    expect(() => buildClaudeArgv({ session: { kind: "resume", sessionId: "" }, headless: true, prompt: "x" }, bins)).toThrow(/session uuid/);
  });

  test("headless without a prompt throws", () => {
    expect(() => buildClaudeArgv({ session: { kind: "start", sessionId: UUID }, headless: true }, bins)).toThrow(/prompt/);
  });

  test("cswap surface uses bare claude args after --", () => {
    const argv = buildClaudeArgv({ account: "a@b.c", session: { kind: "start", sessionId: UUID }, headless: false }, bins);
    expect(argv.slice(0, 4)).toEqual(["/abs/cswap", "run", "a@b.c", "--"]);
    expect(argv).not.toContain("/abs/claude");
  });

  test("interactive start with a reserved handle passes --name and the inbound-accept settings", () => {
    const argv = buildClaudeArgv({
      name: "kai",
      session: { kind: "start", sessionId: UUID }, headless: false,
    }, bins);
    expect(argv).toEqual([
      "/abs/claude", "--name", "kai", "--settings", '{"crossSessionInbound":"accept"}', "--session-id", UUID,
    ]);
  });

  test("headless start with a reserved handle emits neither --name nor --settings", () => {
    const argv = buildClaudeArgv({
      name: "kai",
      session: { kind: "start", sessionId: UUID }, headless: true, prompt: "go",
    }, bins);
    expect(argv).not.toContain("--name");
    expect(argv).not.toContain("--settings");
  });

  test("no reserved handle emits neither flag", () => {
    const argv = buildClaudeArgv({ session: { kind: "start", sessionId: UUID }, headless: false }, bins);
    expect(argv).not.toContain("--name");
    expect(argv).not.toContain("--settings");
  });
});

describe("buildPaneCommand", () => {
  test("cd + invocation + quoted prompt; pane uses bare binary names", () => {
    const cmd = buildPaneCommand("/repo dir", {
      model: "haiku",
      session: { kind: "start", sessionId: UUID }, headless: false, prompt: "hi 'there'",
    });
    expect(cmd).toBe(`cd '/repo dir' && claude '--model' 'haiku' '--session-id' '${UUID}' 'hi '\\''there'\\'''`);
  });

  test("resume without prompt ends at the session id", () => {
    const cmd = buildPaneCommand("/r", { session: { kind: "resume", sessionId: UUID }, headless: false });
    expect(cmd).toBe(`cd '/r' && claude '--resume' '${UUID}'`);
  });

  test("account prefixes cswap run in the pane string", () => {
    const cmd = buildPaneCommand("/r", { account: "a@b.c", session: { kind: "start", sessionId: UUID }, headless: false });
    expect(cmd).toBe(`cd '/r' && cswap run 'a@b.c' -- '--session-id' '${UUID}'`);
  });

  test("single-quotes --name and the JSON --settings value", () => {
    const cmd = buildPaneCommand("/r", {
      name: "kai",
      session: { kind: "start", sessionId: UUID }, headless: false,
    });
    expect(cmd).toBe(`cd '/r' && claude '--name' 'kai' '--settings' '{"crossSessionInbound":"accept"}' '--session-id' '${UUID}'`);
  });
});

test("shellSingleQuote escapes embedded quotes", () => {
  expect(shellSingleQuote("a'b")).toBe(`'a'\\''b'`);
});
