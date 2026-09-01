import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { claudeWorktreeHookStatus, HOOK_TIMEOUT_SECONDS, installClaudeWorktreeHooks, uninstallClaudeWorktreeHooks } from "../claude-settings.ts";

function scratchSettings(content: object): string {
  const p = join(mkdtempSync(join(tmpdir(), "claude-settings-")), "settings.json");
  writeFileSync(p, JSON.stringify(content, null, 2));
  return p;
}

const FOREIGN = {
  model: "opus",
  permissions: { allow: ["Bash(pwd)"] },
  hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "/usr/local/bin/other-tool" }] }] },
};

describe("installClaudeWorktreeHooks", () => {
  test("adds both events and preserves every foreign key", () => {
    const p = scratchSettings(FOREIGN);
    expect(installClaudeWorktreeHooks(p, "/usr/local/bin/rt").changed).toBe(true);
    const after = JSON.parse(readFileSync(p, "utf8"));
    expect(after.model).toBe("opus");
    expect(after.permissions).toEqual(FOREIGN.permissions);
    expect(after.hooks.PreToolUse).toEqual(FOREIGN.hooks.PreToolUse);
    expect(after.hooks.WorktreeCreate[0].hooks[0].command).toBe("/usr/local/bin/rt worktree claude-hook");
    expect(after.hooks.WorktreeCreate[0].hooks[0].timeout).toBe(HOOK_TIMEOUT_SECONDS);
    expect(after.hooks.WorktreeRemove[0].hooks[0].command).toBe("/usr/local/bin/rt worktree claude-hook --remove");
    expect(after.hooks.WorktreeRemove[0].hooks[0].timeout).toBe(HOOK_TIMEOUT_SECONDS);
  });
  test("idempotent: second install is a no-op", () => {
    const p = scratchSettings({});
    installClaudeWorktreeHooks(p, "/usr/local/bin/rt");
    expect(installClaudeWorktreeHooks(p, "/usr/local/bin/rt").changed).toBe(false);
  });
  test("repairs a stale binary path in place", () => {
    const p = scratchSettings({});
    installClaudeWorktreeHooks(p, "/old/rt");
    expect(installClaudeWorktreeHooks(p, "/new/rt").changed).toBe(true);
    const after = JSON.parse(readFileSync(p, "utf8"));
    expect(after.hooks.WorktreeCreate).toHaveLength(1);
    expect(after.hooks.WorktreeCreate[0].hooks[0].command).toBe("/new/rt worktree claude-hook");
  });
  test("creates the file when absent", () => {
    const p = join(mkdtempSync(join(tmpdir(), "claude-settings-")), "settings.json");
    expect(installClaudeWorktreeHooks(p, "/usr/local/bin/rt").changed).toBe(true);
    expect(claudeWorktreeHookStatus(p).installed).toBe(true);
  });
});

describe("uninstallClaudeWorktreeHooks", () => {
  test("removes only rt's entries and leaves foreign hooks", () => {
    const p = scratchSettings(FOREIGN);
    installClaudeWorktreeHooks(p, "/usr/local/bin/rt");
    expect(uninstallClaudeWorktreeHooks(p).changed).toBe(true);
    const after = JSON.parse(readFileSync(p, "utf8"));
    expect(after.hooks.PreToolUse).toEqual(FOREIGN.hooks.PreToolUse);
    expect(after.hooks.WorktreeCreate ?? []).toHaveLength(0);
  });
});

describe("claudeWorktreeHookStatus", () => {
  test("reports absent on a foreign-only file", () => {
    expect(claudeWorktreeHookStatus(scratchSettings(FOREIGN))).toEqual({ installed: false });
  });
  test("reports command and missing binary honestly", () => {
    const p = scratchSettings({});
    installClaudeWorktreeHooks(p, "/definitely/not/here/rt");
    const s = claudeWorktreeHookStatus(p);
    expect(s.installed && s.binaryExists).toBe(false);
  });
});

describe("claudeWorktreeHookStatus: both events required", () => {
  test("a missing WorktreeRemove entry reports not installed", () => {
    const p = scratchSettings({});
    installClaudeWorktreeHooks(p, "/usr/local/bin/rt");
    const s = JSON.parse(readFileSync(p, "utf8"));
    delete s.hooks.WorktreeRemove;
    writeFileSync(p, JSON.stringify(s, null, 2));
    expect(claudeWorktreeHookStatus(p)).toEqual({ installed: false });
  });

  test("a missing WorktreeCreate entry reports not installed even with remove present", () => {
    const p = scratchSettings({});
    installClaudeWorktreeHooks(p, "/usr/local/bin/rt");
    const s = JSON.parse(readFileSync(p, "utf8"));
    delete s.hooks.WorktreeCreate;
    writeFileSync(p, JSON.stringify(s, null, 2));
    expect(claudeWorktreeHookStatus(p)).toEqual({ installed: false });
  });
});
