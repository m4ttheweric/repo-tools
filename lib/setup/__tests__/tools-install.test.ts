import { describe, test, expect, afterEach } from "bun:test";
import { BREW_FORMULAE, VENDOR_INSTALLERS, claudeConfigDirs, installTool, setupTool, type ToolsInstallSeams } from "../tools-install.ts";
import { fakeProbes, ok, missing } from "./fakes.ts";
import type { ExecScript } from "./fakes.ts";
import type { PackRequirements } from "../requirements.ts";
import type { ToolResolution } from "../../deps/resolve.ts";
import type { LinkOutcome } from "../../deps/links.ts";
import type { DetectedEditor } from "../../editors.ts";
import { UserActionableError } from "../errors.ts";
import { readSetupState } from "../state.ts";

function noopResolution(tool: string): ToolResolution {
  return { tool, bundled: null, exec: null, userCopy: null, linked: false, chosen: null };
}

/** No bundled tool, no editors, real resolveTool/link never invoked — the safe default for a test that only cares about one branch. */
const NOOP_SEAMS: ToolsInstallSeams = {
  resolveTool: (_p, tool) => noopResolution(tool),
  detectEditors: () => [],
  findVsix: () => null,
  bundledToolExec: () => null,
  link: () => {
    throw new Error("link() should not be called in this test");
  },
};

describe("installTool — tool.herdr / tool.claude (brew, vendor)", () => {
  test("herdr with brew present -> brew install herdr", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "brew" && argv[1] === "--version") return ok("4.0.0");
      if (argv[0] === "brew" && argv[1] === "install") return ok();
      if (argv[0] === "herdr" && argv[1] === "--version") return ok("0.8.0");
      return ok();
    };
    const p = fakeProbes({ exec });
    const result = await installTool(p, "herdr", [], NOOP_SEAMS);
    expect(p.calls.exec).toContainEqual(["brew", "install", "herdr"]);
    expect(result).toEqual({ via: "brew", ok: true, detail: "installed via brew (herdr)" });
  });

  test("herdr without brew -> fetches the URL as its own argv element (curl -o), then runs the downloaded file as an argv step (never sh -c)", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "brew" && argv[1] === "--version") return missing("brew");
      if (argv[0] === "curl") return ok();
      if (argv[0] === "sh") return ok();
      if (argv[0] === "herdr" && argv[1] === "--version") return ok("0.8.0");
      return ok();
    };
    const p = fakeProbes({ exec });
    const result = await installTool(p, "herdr", [], NOOP_SEAMS);

    const fetchCall = p.calls.exec.find((argv) => argv[0] === "curl");
    expect(fetchCall).toBeDefined();
    expect(fetchCall).toEqual(["curl", "-fsSL", VENDOR_INSTALLERS.herdr!, "-o", fetchCall![4]!]);

    const runCall = p.calls.exec.find((argv) => argv[0] === "sh");
    expect(runCall).toBeDefined();
    expect(runCall).toEqual(["sh", fetchCall![4]!]);

    expect(result.via).toBe("vendor");
    expect(result.ok).toBe(true);
  });

  test("no exec call ever constructs a shell string (no 'sh -c', no pipe-to-shell) — argv only, every element", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "brew" && argv[1] === "--version" ? missing("brew") : ok());
    const p = fakeProbes({ exec });
    await installTool(p, "herdr", [], NOOP_SEAMS);
    for (const argv of p.calls.exec) {
      expect(argv).not.toContain("-c");
      for (const arg of argv) expect(arg).not.toContain("|");
    }
  });

  test("claude formula is claude-code", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "brew" && argv[1] === "--version") return ok();
      if (argv[0] === "brew" && argv[1] === "install") return ok();
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.0.0");
      return ok();
    };
    const p = fakeProbes({ exec });
    await installTool(p, "claude", [], NOOP_SEAMS);
    expect(p.calls.exec).toContainEqual(["brew", "install", BREW_FORMULAE.claude!]);
  });

  test("brew install exits non-zero -> error, not claimed installed", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "brew" && argv[1] === "--version") return ok();
      if (argv[0] === "brew" && argv[1] === "install") return { code: 1, stdout: "", stderr: "boom" };
      return ok();
    };
    const p = fakeProbes({ exec });
    const result = await installTool(p, "herdr", [], NOOP_SEAMS);
    expect(result).toEqual({ via: "brew", ok: false, detail: expect.stringContaining("exit 1") });
  });

  test("brew install times out (124) -> honest error, never installed", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "brew" && argv[1] === "--version") return ok();
      if (argv[0] === "brew" && argv[1] === "install") return { code: 124, stdout: "", stderr: "" };
      return ok();
    };
    const p = fakeProbes({ exec });
    const result = await installTool(p, "herdr", [], NOOP_SEAMS);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("timed out");
  });

  test("brew install exits 0 but the tool still isn't runnable -> not claimed installed (re-probe, never trust exit code alone)", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "brew" && argv[1] === "--version") return ok();
      if (argv[0] === "brew" && argv[1] === "install") return ok();
      if (argv[0] === "herdr" && argv[1] === "--version") return missing("herdr");
      return ok();
    };
    const p = fakeProbes({ exec });
    const result = await installTool(p, "herdr", [], NOOP_SEAMS);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not claiming success");
  });
});

describe("installTool — team-declared tool via reqs", () => {
  test("team tool with install.brew -> that formula", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "doppler", why: "reads secrets", install: { brew: "doppler-cli" } }] }];
    const exec: ExecScript = (argv) => {
      if (argv[0] === "brew" && argv[1] === "--version") return ok();
      if (argv[0] === "brew" && argv[1] === "install") return ok();
      if (argv[0] === "doppler" && argv[1] === "--version") return ok("3.0.0");
      return ok();
    };
    const p = fakeProbes({ exec });
    const result = await installTool(p, "doppler", reqs, NOOP_SEAMS);
    expect(p.calls.exec).toContainEqual(["brew", "install", "doppler-cli"]);
    expect(result).toEqual({ via: "brew", ok: true, detail: "installed via brew (doppler-cli)" });
  });

  test("no bundled tool, no brew formula, no vendor url -> UserActionableError no-installer", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "mystery", why: "unlisted" }] }];
    const exec: ExecScript = (argv) => (argv[0] === "brew" && argv[1] === "--version" ? missing("brew") : ok());
    const p = fakeProbes({ exec });
    await expect(installTool(p, "mystery", reqs, NOOP_SEAMS)).rejects.toThrow(UserActionableError);
  });
});

describe("installTool — vendor security (R-T21): team-authored URLs are never auto-executed; only rt's own hardcoded, allowlisted, https URLs run, and only argv-only, fetch-then-run", () => {
  const originalHerdrUrl = VENDOR_INSTALLERS.herdr!;
  afterEach(() => {
    VENDOR_INSTALLERS.herdr = originalHerdrUrl;
  });

  test("a team-declared install.url is refused, never executed, even if it contains shell metacharacters", async () => {
    const reqs: PackRequirements[] = [
      { pack: "somepack", integrations: [], tools: [{ name: "widget", why: "does widget things", install: { url: "https://evil.example.com/x.sh; rm -rf ~" } }] },
    ];
    const exec: ExecScript = (argv) => (argv[0] === "brew" && argv[1] === "--version" ? missing("brew") : ok());
    const p = fakeProbes({ exec });
    await expect(installTool(p, "widget", reqs, NOOP_SEAMS)).rejects.toThrow(UserActionableError);
    await expect(installTool(p, "widget", reqs, NOOP_SEAMS)).rejects.toThrow(/manual-install-required|install it yourself/);
    expect(p.calls.exec.some((argv) => argv[0] === "curl" || argv[0] === "sh")).toBe(false);
  });

  test("a hardcoded vendor URL that isn't https is refused, never fetched", async () => {
    VENDOR_INSTALLERS.herdr = "http://herdr.dev/install.sh";
    const exec: ExecScript = (argv) => (argv[0] === "brew" && argv[1] === "--version" ? missing("brew") : ok());
    const p = fakeProbes({ exec });
    const result = await installTool(p, "herdr", [], NOOP_SEAMS);
    expect(result.via).toBe("vendor");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("https");
    expect(p.calls.exec.some((argv) => argv[0] === "curl")).toBe(false);
  });

  test("a hardcoded vendor URL on a host outside the known list is refused, never fetched", async () => {
    VENDOR_INSTALLERS.herdr = "https://evil.example.com/install.sh";
    const exec: ExecScript = (argv) => (argv[0] === "brew" && argv[1] === "--version" ? missing("brew") : ok());
    const p = fakeProbes({ exec });
    const result = await installTool(p, "herdr", [], NOOP_SEAMS);
    expect(result.via).toBe("vendor");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("evil.example.com");
    expect(p.calls.exec.some((argv) => argv[0] === "curl")).toBe(false);
  });

  test("a malformed URL is refused, never fetched", async () => {
    VENDOR_INSTALLERS.herdr = "not a url";
    const exec: ExecScript = (argv) => (argv[0] === "brew" && argv[1] === "--version" ? missing("brew") : ok());
    const p = fakeProbes({ exec });
    const result = await installTool(p, "herdr", [], NOOP_SEAMS);
    expect(result.ok).toBe(false);
    expect(p.calls.exec.some((argv) => argv[0] === "curl")).toBe(false);
  });

  test("curl fetch failure is honest and never runs the (partial/missing) downloaded file", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "brew" && argv[1] === "--version") return missing("brew");
      if (argv[0] === "curl") return { code: 22, stdout: "", stderr: "404" };
      return ok();
    };
    const p = fakeProbes({ exec });
    const result = await installTool(p, "herdr", [], NOOP_SEAMS);
    expect(result).toEqual({ via: "vendor", ok: false, detail: expect.stringContaining("download failed") });
    expect(p.calls.exec.some((argv) => argv[0] === "sh")).toBe(false);
  });

  test("curl fetch timeout is honest, never claimed as a run", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "brew" && argv[1] === "--version") return missing("brew");
      if (argv[0] === "curl") return { code: 124, stdout: "", stderr: "" };
      return ok();
    };
    const p = fakeProbes({ exec });
    const result = await installTool(p, "herdr", [], NOOP_SEAMS);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("timed out");
    expect(p.calls.exec.some((argv) => argv[0] === "sh")).toBe(false);
  });
});

describe("installTool — bundled-link", () => {
  test("gh -> link via bundled-link", async () => {
    const seams: ToolsInstallSeams = {
      ...NOOP_SEAMS,
      bundledToolExec: (_p, tool) => (tool === "gh" ? ["/bundle/Contents/Helpers/gh"] : null),
      link: (_p, tool) => ({ ok: true, path: `/fake-home/.local/bin/${tool}`, state: "linked" }) as LinkOutcome,
    };
    const p = fakeProbes();
    const result = await installTool(p, "gh", [], seams);
    expect(result).toEqual({ via: "bundled-link", ok: true, detail: expect.stringContaining("/fake-home/.local/bin/gh") });
    // bundled-link takes priority over brew/vendor — no exec call for install at all.
    expect(p.calls.exec.some((argv) => argv[0] === "brew")).toBe(false);
  });

  test("gh bundled but link() refuses (occupied) -> honest failure", async () => {
    const seams: ToolsInstallSeams = {
      ...NOOP_SEAMS,
      bundledToolExec: () => ["/bundle/Contents/Helpers/gh"],
      link: () => ({ ok: false, reason: "occupied", detail: "already occupied" }) as LinkOutcome,
    };
    const p = fakeProbes();
    const result = await installTool(p, "gh", [], seams);
    expect(result).toEqual({ via: "bundled-link", ok: false, detail: "already occupied" });
  });
});

describe("installTool — apple-clt", () => {
  test("apple-clt -> xcode-select --install argv", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "xcode-select" && argv[1] === "--install" ? ok() : ok());
    const p = fakeProbes({ exec });
    const result = await installTool(p, "apple-clt", [], NOOP_SEAMS);
    expect(p.calls.exec).toContainEqual(["xcode-select", "--install"]);
    expect(result.via).toBe("apple-clt");
    expect(result.ok).toBe(true);
  });

  test("apple-clt code 1 'already installed' -> ok (honest, not re-triggered)", async () => {
    const exec: ExecScript = () => ({ code: 1, stdout: "", stderr: "xcode-select: error: command line tools are already installed" });
    const p = fakeProbes({ exec });
    const result = await installTool(p, "apple-clt", [], NOOP_SEAMS);
    expect(result.ok).toBe(true);
    expect(result.via).toBe("apple-clt");
  });

  test("apple-clt code 1 for another reason -> honest failure, not ok", async () => {
    const exec: ExecScript = () => ({ code: 1, stdout: "", stderr: "some other failure" });
    const p = fakeProbes({ exec });
    const result = await installTool(p, "apple-clt", [], NOOP_SEAMS);
    expect(result.ok).toBe(false);
  });

  test("apple-clt never claims completion — detail says the OS dialog must be completed by the user", async () => {
    const exec: ExecScript = () => ok();
    const p = fakeProbes({ exec });
    const result = await installTool(p, "apple-clt", [], NOOP_SEAMS);
    expect(result.detail.toLowerCase()).not.toContain("installed");
  });
});

describe("setupTool — fast-browser", () => {
  test("exec=[node, mjs] records argv [node, mjs, setup]", async () => {
    const seams: ToolsInstallSeams = {
      ...NOOP_SEAMS,
      resolveTool: (_p, tool) => (tool === "fast-browser" ? { tool, bundled: "node", exec: ["node", "fast-browser.mjs"], userCopy: null, linked: false, chosen: "node" } : noopResolution(tool)),
    };
    const exec: ExecScript = (argv) => (argv[0] === "node" ? ok() : ok());
    const p = fakeProbes({ exec });
    const result = await setupTool(p, "fast-browser", { configDirs: [] }, seams);
    expect(p.calls.exec).toContainEqual(["node", "fast-browser.mjs", "setup"]);
    expect(result.ok).toBe(true);
  });

  test("exec null -> UserActionableError tool-missing", async () => {
    const p = fakeProbes();
    await expect(setupTool(p, "fast-browser", { configDirs: [] }, NOOP_SEAMS)).rejects.toThrow(UserActionableError);
  });

  test("setup script exits non-zero -> honest failure", async () => {
    const seams: ToolsInstallSeams = {
      ...NOOP_SEAMS,
      resolveTool: (_p, tool) => (tool === "fast-browser" ? { tool, bundled: "node", exec: ["node", "fast-browser.mjs"], userCopy: null, linked: false, chosen: "node" } : noopResolution(tool)),
    };
    const exec: ExecScript = () => ({ code: 1, stdout: "", stderr: "boom" });
    const p = fakeProbes({ exec });
    const result = await setupTool(p, "fast-browser", { configDirs: [] }, seams);
    expect(result.ok).toBe(false);
  });
});

describe("setupTool — herdr", () => {
  test("configDirs:[a,b] runs herdr integration install claude twice, once per dir, with CLAUDE_CONFIG_DIR", async () => {
    const seen: Array<{ argv: string[]; env?: Record<string, string> }> = [];
    const exec: ExecScript = (argv, opts) => {
      seen.push({ argv, env: opts?.env });
      return ok();
    };
    const p = fakeProbes({ exec });
    const result = await setupTool(p, "herdr", { configDirs: ["/a/.claude", "/b/.claude"] }, NOOP_SEAMS);
    const herdrCalls = seen.filter((c) => c.argv[0] === "herdr");
    expect(herdrCalls).toHaveLength(2);
    expect(herdrCalls[0]!.argv).toEqual(["herdr", "integration", "install", "claude"]);
    expect(herdrCalls[0]!.env).toEqual({ CLAUDE_CONFIG_DIR: "/a/.claude" });
    expect(herdrCalls[1]!.env).toEqual({ CLAUDE_CONFIG_DIR: "/b/.claude" });
    expect(result.ok).toBe(true);
  });

  test("one dir fails -> ok:false, other dir's success still reported honestly", async () => {
    const exec: ExecScript = (argv, opts) => {
      if (opts?.env?.CLAUDE_CONFIG_DIR === "/b/.claude") return { code: 1, stdout: "", stderr: "boom" };
      return ok();
    };
    const p = fakeProbes({ exec });
    const result = await setupTool(p, "herdr", { configDirs: ["/a/.claude", "/b/.claude"] }, NOOP_SEAMS);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("/a/.claude");
    expect(result.detail).toContain("/b/.claude");
  });
});

describe("setupTool — extension", () => {
  test("installs into every detected editor and records editors in setup-state", async () => {
    const editors: DetectedEditor[] = [
      { name: "Cursor", cliPath: "/Applications/Cursor.app/cli", appPath: "/Applications/Cursor.app" },
      { name: "Visual Studio Code", cliPath: "/Applications/Code.app/cli", appPath: "/Applications/Code.app" },
    ];
    const seams: ToolsInstallSeams = { ...NOOP_SEAMS, findVsix: () => "/fake/rt-context.vsix", detectEditors: () => editors };
    const exec: ExecScript = (argv) => (argv.includes("--install-extension") ? ok() : ok());
    const p = fakeProbes({ exec, home: "/fake-home" });
    const result = await setupTool(p, "extension", { configDirs: [] }, seams);
    expect(p.calls.exec).toContainEqual(["/Applications/Cursor.app/cli", "--install-extension", "/fake/rt-context.vsix", "--force"]);
    expect(p.calls.exec).toContainEqual(["/Applications/Code.app/cli", "--install-extension", "/fake/rt-context.vsix", "--force"]);
    expect(result.ok).toBe(true);

    const state = readSetupState(p);
    expect(state.extensionEditors).toContain("Cursor");
    expect(state.extensionEditors).toContain("Visual Studio Code");
  });

  test("no vsix found -> honest failure, no editors touched", async () => {
    const seams: ToolsInstallSeams = { ...NOOP_SEAMS, findVsix: () => null, detectEditors: () => [{ name: "Cursor", cliPath: "/x/cli", appPath: "/x" }] };
    const p = fakeProbes({ home: "/fake-home" });
    const result = await setupTool(p, "extension", { configDirs: [] }, seams);
    expect(result.ok).toBe(false);
    expect(p.calls.exec).toHaveLength(0);
  });

  test("no editors detected -> honest failure", async () => {
    const seams: ToolsInstallSeams = { ...NOOP_SEAMS, findVsix: () => "/fake/rt-context.vsix", detectEditors: () => [] };
    const p = fakeProbes({ home: "/fake-home" });
    const result = await setupTool(p, "extension", { configDirs: [] }, seams);
    expect(result.ok).toBe(false);
  });

  test("one editor's install fails -> ok:false but the other's success is still recorded (never claim a guess)", async () => {
    const editors: DetectedEditor[] = [
      { name: "Cursor", cliPath: "/x/cursor-cli", appPath: "/x/Cursor.app" },
      { name: "Windsurf", cliPath: "/x/windsurf-cli", appPath: "/x/Windsurf.app" },
    ];
    const seams: ToolsInstallSeams = { ...NOOP_SEAMS, findVsix: () => "/fake/rt-context.vsix", detectEditors: () => editors };
    const exec: ExecScript = (argv) => (argv[0] === "/x/windsurf-cli" ? { code: 1, stdout: "", stderr: "boom" } : ok());
    const p = fakeProbes({ exec, home: "/fake-home" });
    const result = await setupTool(p, "extension", { configDirs: [] }, seams);
    expect(result.ok).toBe(false);

    const state = readSetupState(p);
    expect(state.extensionEditors).toEqual(["Cursor"]);
  });
});

describe("setupTool — unknown tool", () => {
  test("throws UserActionableError unknown-tool-setup", async () => {
    const p = fakeProbes();
    await expect(setupTool(p, "not-a-real-tool", { configDirs: [] }, NOOP_SEAMS)).rejects.toThrow(UserActionableError);
  });
});

describe("claudeConfigDirs", () => {
  test("defaults to ~/.claude when CLAUDE_CONFIG_DIR is unset, plus extras deduped", () => {
    const p = { env: {}, home: "/fake-home" };
    expect(claudeConfigDirs(p, ["/fake-home/.claude", "/other/.claude"])).toEqual(["/fake-home/.claude", "/other/.claude"]);
  });

  test("honors CLAUDE_CONFIG_DIR when set", () => {
    const p = { env: { CLAUDE_CONFIG_DIR: "/custom/.claude" }, home: "/fake-home" };
    expect(claudeConfigDirs(p, [])).toEqual(["/custom/.claude"]);
  });
});
