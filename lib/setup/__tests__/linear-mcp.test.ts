import { describe, expect, test } from "bun:test";
import {
  callableBySkills,
  claudeJsonPath,
  isLinearMcp,
  linearServerNames,
  nameTaken,
  readClaudeConfig,
  withLinearEntry,
  writeClaudeConfig,
  LINEAR_MCP_URL,
} from "../linear-mcp.ts";
import { fakeProbes } from "./fakes.ts";

const hosted = { type: "http", url: LINEAR_MCP_URL, headers: { Authorization: "Bearer lin_api_x" } };

describe("claudeJsonPath", () => {
  test("no CLAUDE_CONFIG_DIR -> ~/.claude.json, not ~/.claude/.claude.json", () => {
    expect(claudeJsonPath({ env: {}, home: "/h" })).toBe("/h/.claude.json");
  });
  test("CLAUDE_CONFIG_DIR set -> that dir's .claude.json", () => {
    expect(claudeJsonPath({ env: { CLAUDE_CONFIG_DIR: "/cfg" }, home: "/h" })).toBe("/cfg/.claude.json");
  });
});

describe("isLinearMcp", () => {
  test("hosted http entry", () => expect(isLinearMcp(hosted)).toBe(true));
  test("sse transport at the same host", () => expect(isLinearMcp({ type: "sse", url: "https://mcp.linear.app/sse" })).toBe(true));
  test("hosted entry with no auth header is still a Linear MCP (OAuth)", () => {
    expect(isLinearMcp({ type: "http", url: LINEAR_MCP_URL })).toBe(true);
  });
  test("stdio linear-mcp package", () => {
    expect(isLinearMcp({ command: "npx", args: ["-y", "@anthropic-ai/linear-mcp-server"] })).toBe(true);
  });
  test("a different host that merely mentions linear is not one", () => {
    expect(isLinearMcp({ type: "http", url: "https://evil.example.com/mcp.linear.app" })).toBe(false);
  });
  test("an unrelated server is not one", () => expect(isLinearMcp({ type: "http", url: "https://mcp.railway.app/mcp" })).toBe(false));
  test("junk values do not throw", () => {
    expect(isLinearMcp(null)).toBe(false);
    expect(isLinearMcp("linear")).toBe(false);
    expect(isLinearMcp({ url: 42 })).toBe(false);
  });
});

describe("readClaudeConfig", () => {
  test("absent file", () => {
    expect(readClaudeConfig(fakeProbes({}), "/h/.claude.json")).toEqual({ ok: false, reason: "absent" });
  });
  test("unparsable file", () => {
    const p = fakeProbes({ files: { "/h/.claude.json": "{ not json" } });
    expect(readClaudeConfig(p, "/h/.claude.json")).toEqual({ ok: false, reason: "unparsable" });
  });
  test("a JSON scalar is not a config object", () => {
    const p = fakeProbes({ files: { "/h/.claude.json": "42" } });
    expect(readClaudeConfig(p, "/h/.claude.json")).toEqual({ ok: false, reason: "unparsable" });
  });
  test("a file that exists but cannot be read is unreadable, never absent", () => {
    const p = fakeProbes({ files: { "/h/.claude.json": JSON.stringify({ numStartups: 3 }) }, unreadable: ["/h/.claude.json"] });
    expect(readClaudeConfig(p, "/h/.claude.json")).toEqual({ ok: false, reason: "unreadable" });
  });
  test("parses", () => {
    const p = fakeProbes({ files: { "/h/.claude.json": JSON.stringify({ numStartups: 3 }) } });
    expect(readClaudeConfig(p, "/h/.claude.json")).toEqual({ ok: true, config: { numStartups: 3 } });
  });
  test("an mcpServers that is not a plain object is unparsable, never merged over", () => {
    for (const servers of ["[]", '"x"', "7"]) {
      const p = fakeProbes({ files: { "/h/.claude.json": `{"mcpServers": ${servers}}` } });
      expect(readClaudeConfig(p, "/h/.claude.json")).toEqual({ ok: false, reason: "unparsable" });
    }
  });
  test("a null or missing mcpServers still parses", () => {
    const nulled = fakeProbes({ files: { "/h/.claude.json": '{"mcpServers": null}' } });
    expect(readClaudeConfig(nulled, "/h/.claude.json").ok).toBe(true);
    const empty = fakeProbes({ files: { "/h/.claude.json": "{}" } });
    expect(readClaudeConfig(empty, "/h/.claude.json")).toEqual({ ok: true, config: {} });
  });
});

describe("detection by shape, under any name", () => {
  test("finds every Linear MCP whatever it is called", () => {
    const config = { mcpServers: { "linear-matt": hosted, railway: { type: "http", url: "https://mcp.railway.app/mcp" }, work: hosted } };
    expect(linearServerNames(config)).toEqual(["linear-matt", "work"]);
  });
  test("no mcpServers at all", () => expect(linearServerNames({})).toEqual([]));
  test("callableBySkills needs the name linear AND the shape", () => {
    expect(callableBySkills({ mcpServers: { linear: hosted } })).toBe(true);
    expect(callableBySkills({ mcpServers: { "linear-matt": hosted } })).toBe(false);
    expect(callableBySkills({ mcpServers: { linear: { type: "http", url: "https://mcp.railway.app/mcp" } } })).toBe(false);
  });
  test("nameTaken is about the key, not the shape", () => {
    expect(nameTaken({ mcpServers: { linear: { type: "http", url: "https://mcp.railway.app/mcp" } } })).toBe(true);
    expect(nameTaken({ mcpServers: { "linear-matt": hosted } })).toBe(false);
  });
});

describe("withLinearEntry", () => {
  test("adds exactly one key and preserves everything else", () => {
    const before = { numStartups: 3, mcpServers: { "linear-matt": hosted, railway: { type: "http", url: "https://mcp.railway.app/mcp" } } };
    const after = withLinearEntry(before, "lin_api_new");
    expect(after.mcpServers!.linear).toEqual({ type: "http", url: LINEAR_MCP_URL, headers: { Authorization: "Bearer lin_api_new" } });
    expect(after.mcpServers!["linear-matt"]).toBe(hosted);
    expect(after.mcpServers!.railway).toEqual({ type: "http", url: "https://mcp.railway.app/mcp" });
    expect(after.numStartups).toBe(3);
  });
  test("creates mcpServers when the config has none", () => {
    expect(Object.keys(withLinearEntry({ numStartups: 1 }, "k").mcpServers!)).toEqual(["linear"]);
  });
  test("does not mutate its input", () => {
    const before = { mcpServers: {} as Record<string, never> };
    withLinearEntry(before, "k");
    expect(before.mcpServers).toEqual({});
  });
});

describe("writeClaudeConfig", () => {
  test("lands the merged config at the real path via a temp file", () => {
    const p = fakeProbes({ files: { "/h/.claude.json": JSON.stringify({ numStartups: 3 }, null, 2) } });
    writeClaudeConfig(p, "/h/.claude.json", withLinearEntry({ numStartups: 3 }, "lin_api_k"));
    expect(p.calls.renames).toEqual([["/h/.claude.json.rt-tmp", "/h/.claude.json"]]);
    expect(JSON.parse(p.readFile("/h/.claude.json")!)).toEqual({
      numStartups: 3,
      mcpServers: { linear: { type: "http", url: LINEAR_MCP_URL, headers: { Authorization: "Bearer lin_api_k" } } },
    });
    expect(p.readFile("/h/.claude.json.rt-tmp")).toBeNull();
  });

  test("writes 2-space JSON, matching the file Claude Code keeps", () => {
    const p = fakeProbes({});
    writeClaudeConfig(p, "/h/.claude.json", { a: 1 });
    expect(p.readFile("/h/.claude.json")).toBe('{\n  "a": 1\n}\n');
  });

  test("the config lands 0600, since the rename carries the temp file's mode", () => {
    const p = fakeProbes({});
    writeClaudeConfig(p, "/h/.claude.json", { a: 1 });
    expect(p.calls.modes["/h/.claude.json"]).toBe(0o600);
  });

  test("a leftover world-readable temp file cannot carry its mode onto the token-bearing config", () => {
    const p = fakeProbes({ files: { "/h/.claude.json.rt-tmp": "{}\n" } });
    p.chmod("/h/.claude.json.rt-tmp", 0o644); // the mode an earlier failed rename left behind
    writeClaudeConfig(p, "/h/.claude.json", { a: 1 });
    expect(p.calls.modes["/h/.claude.json"]).toBe(0o600);
  });

  test("a rename that throws takes the token-bearing temp file with it", () => {
    const p = fakeProbes({});
    const throwing = {
      ...p,
      rename() {
        throw new Error("EXDEV");
      },
    };
    expect(() => writeClaudeConfig(throwing, "/h/.claude.json", { a: 1 })).toThrow("EXDEV");
    expect(p.calls.removed).toContain("/h/.claude.json.rt-tmp");
    expect(p.readFile("/h/.claude.json.rt-tmp")).toBeNull();
  });
});
