import { describe, test, expect } from "bun:test";
import { toolRows, extractVersion } from "../validators/tools.ts";
import type { ToolsSeams } from "../validators/tools.ts";
import { fakeProbes, ok, missing } from "./fakes.ts";
import type { ExecScript } from "./fakes.ts";
import type { PackRequirements } from "../requirements.ts";
import type { ToolResolution } from "../../deps/resolve.ts";
import type { DetectedEditor } from "../../editors.ts";

/** No bundled/user copy of anything, no detected editors — the safe default so a test that doesn't care about tool.fast-browser or tool.editor never touches the real machine's /Applications or a real bundle lookup. */
function noopResolution(tool: string): ToolResolution {
  return { tool, bundled: null, exec: null, userCopy: null, linked: false, chosen: null };
}

const NOOP_SEAMS: ToolsSeams = { resolveTool: (_p, tool) => noopResolution(tool), detectEditors: () => [] };

const TIMEOUT: ExecScript = () => ({ code: 124, stdout: "", stderr: "" });

async function pickRow(rowsP: ReturnType<typeof toolRows>, id: string) {
  const rows = await rowsP;
  const r = rows.find((row) => row.id === id);
  if (!r) throw new Error(`no row ${id}; got ids: ${rows.map((row) => row.id).join(", ")}`);
  return r;
}

describe("extractVersion", () => {
  test("plain version string", () => expect(extractVersion("0.8.0\n")).toBe("0.8.0"));
  test("prefixed with a leading v", () => expect(extractVersion("v0.8.0")).toBe("0.8.0"));
  test("prose before the version", () => expect(extractVersion("herdr version 0.8.0")).toBe("0.8.0"));
  test("a build-date-prefixed banner prefers the dotted version over the leading date", () => {
    expect(extractVersion("2026-08-22 build 1.2.3")).toBe("1.2.3");
  });
  test("a bare number with no dots falls back to the number", () => expect(extractVersion("24")).toBe("24"));
  test("nothing numeric falls back to the trimmed input", () => expect(extractVersion("  no version here  ")).toBe("no version here"));
});

describe("toolRows — tool.herdr", () => {
  test("127 with brew available -> missing, install action via brew", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "herdr" && argv[1] === "--version" ? missing("herdr") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("missing");
    expect(r.action).toEqual({ type: "install", label: "Install", tool: "herdr", via: "brew" });
  });

  test("127 with no brew -> install action via vendor", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "herdr" && argv[1] === "--version" ? missing("herdr") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: false }, NOOP_SEAMS), "tool.herdr");
    expect(r.action).toEqual({ type: "install", label: "Install", tool: "herdr", via: "vendor" });
  });

  test("--version times out -> error, never missing/needs-you", async () => {
    const r = await pickRow(toolRows(fakeProbes({ exec: TIMEOUT }), [], { hasBrew: true }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("timed out");
  });

  test("0.8.0 + the claude line reads 'current' -> ready", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "herdr" && argv[1] === "--version") return ok("0.8.0\n");
      if (argv[0] === "herdr" && argv[1] === "integration" && argv[2] === "status") {
        return ok("claude: current (v7) (/Users/x/.claude/hooks/herdr-agent-state.sh)\ncodex: current (v7) (/Users/x/.codex/herdr-agent-state.sh)\n");
      }
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("herdr 0.8.0, Claude integration installed");
    expect(r.required).toBe(true);
  });

  test("the claude line reads 'not installed' -> needs-you, not a false ready (H1)", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "herdr" && argv[1] === "--version") return ok("0.9.0\n");
      if (argv[0] === "herdr" && argv[1] === "integration" && argv[2] === "status") {
        return ok("claude: not installed (/Users/x/.claude/hooks/herdr-agent-state.sh)\ncodex: current (v7) (/Users/x/.codex/herdr-agent-state.sh)\n");
      }
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toBe("herdr 0.9.0, Claude integration not installed");
    expect(r.action).toEqual({ type: "run", label: "Install integration", verb: ["tools", "setup", "herdr"] });
  });

  test("the claude line is entirely absent -> error, never a determined negative", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "herdr" && argv[1] === "--version") return ok("0.9.0\n");
      if (argv[0] === "herdr" && argv[1] === "integration") return ok("codex: current (v7) (/x)\n");
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("error");
  });

  test("integration status times out -> error", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "herdr" && argv[1] === "--version") return ok("0.9.0\n");
      if (argv[0] === "herdr" && argv[1] === "integration") return { code: 124, stdout: "", stderr: "" };
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("error");
  });

  test("integration status a hard failure (non-0, non-124) -> error", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "herdr" && argv[1] === "--version") return ok("0.9.0\n");
      if (argv[0] === "herdr" && argv[1] === "integration") return { code: 1, stdout: "", stderr: "boom" };
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("error");
  });

  test("below floor -> invalid, with an upgrade action (R-T7-b, no dead end)", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "herdr" && argv[1] === "--version" ? ok("0.7.4\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("invalid");
    expect(r.detail).toBe("herdr 0.7.4 < 0.7.5");
    expect(r.action).toEqual({ type: "install", label: "Upgrade", tool: "herdr", via: "brew" });
  });
});

describe("toolRows — tool.claude", () => {
  test("127 -> missing, install action", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "--version" ? missing("claude") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("missing");
    expect(r.action).toEqual({ type: "install", label: "Install", tool: "claude", via: "brew" });
    expect(r.recheck).toBe("on-activate");
  });

  test("--version times out -> error", async () => {
    const r = await pickRow(toolRows(fakeProbes({ exec: TIMEOUT }), [], { hasBrew: true }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("error");
  });

  test("auth status JSON loggedIn:true -> ready, signed in (never trusts exit 0 alone)", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.2.3\n");
      if (argv[0] === "claude" && argv[1] === "auth" && argv[2] === "status") return ok(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("claude 1.2.3, signed in");
  });

  test("auth status JSON loggedIn:false, exit 0 -> needs-you (M2: exit 0 is not proof of sign-in)", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.2.3\n");
      if (argv[0] === "claude" && argv[1] === "auth") return ok(JSON.stringify({ loggedIn: false }));
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toBe("sign in: run claude once");
    expect(r.action).toEqual({ type: "steps", label: "Show steps…", steps: ["Open a terminal", "Run: claude", "Follow the sign-in prompt"] });
  });

  test("auth status unknown subcommand (stderr mentions unknown) -> needs-you, sign-in not checked — never a guessed ready (H-1)", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.2.3\n");
      if (argv[0] === "claude" && argv[1] === "auth") return { code: 1, stdout: "", stderr: "unknown command \"auth\"" };
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("sign-in could not be checked");
    expect(r.action).not.toBeNull();
  });

  test("unknown subcommand sniffed off STDOUT too, not stderr only (L13) -> needs-you, never a guessed ready (H-1)", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.2.3\n");
      if (argv[0] === "claude" && argv[1] === "auth") return { code: 1, stdout: "Unknown subcommand: auth", stderr: "" };
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("sign-in could not be checked");
  });

  test("auth status known non-zero exit, non-JSON -> needs-you, sign in steps", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.2.3\n");
      if (argv[0] === "claude" && argv[1] === "auth") return { code: 1, stdout: "", stderr: "not logged in" };
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toBe("sign in: run claude once");
  });

  test("auth status times out -> error", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.2.3\n");
      if (argv[0] === "claude" && argv[1] === "auth") return { code: 124, stdout: "", stderr: "" };
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("error");
  });

  test("auth status exits 0 with an unparseable, non-'unknown' response -> error (can't determine)", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.2.3\n");
      if (argv[0] === "claude" && argv[1] === "auth") return ok("garbled non-json output");
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("error");
  });
});

describe("toolRows — tool.fast-browser", () => {
  test("exec null -> missing, bundled-link action", async () => {
    const r = await pickRow(toolRows(fakeProbes(), [], { hasBrew: true }, NOOP_SEAMS), "tool.fast-browser");
    expect(r.status).toBe("missing");
    expect(r.action).toEqual({ type: "link-bundled", label: "Use mattstack's", tool: "fast-browser" });
    expect(r.recheck).toBe("on-activate");
  });

  function fastBrowserSeams(): ToolsSeams {
    return { ...NOOP_SEAMS, resolveTool: (_p, tool) => (tool === "fast-browser" ? { tool, bundled: "node", exec: ["node", "fast-browser.mjs"], userCopy: null, linked: false, chosen: "node" } : noopResolution(tool)) };
  }

  test("bundled exec [node, mjs] -> doctor invoked with the full argv, and extension not loaded -> needs-you with 3 steps", async () => {
    const seams = fastBrowserSeams();
    const exec: ExecScript = (argv) => {
      if (argv[0] === "node" && argv[1] === "fast-browser.mjs" && argv[2] === "doctor" && argv[3] === "--json") {
        return ok(JSON.stringify({ runtime: { ok: true }, extension: { loaded: false } }));
      }
      return ok();
    };
    const p = fakeProbes({ exec });
    const r = await pickRow(toolRows(p, [], { hasBrew: true }, seams), "tool.fast-browser");
    expect(p.calls.exec).toContainEqual(["node", "fast-browser.mjs", "doctor", "--json"]);
    expect(r.status).toBe("needs-you");
    expect(r.action).toEqual({
      type: "steps",
      label: "Show steps…",
      steps: ["Open chrome://extensions", "Turn on Developer mode", "Load unpacked → ~/.fast-browser/extension/current/unpacked"],
    });
  });

  test("runtime ok and extension loaded -> ready", async () => {
    const exec: ExecScript = (argv) => (argv[2] === "doctor" ? ok(JSON.stringify({ runtime: { ok: true }, extension: { loaded: true }, pairing: { ok: true } })) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, fastBrowserSeams()), "tool.fast-browser");
    expect(r.status).toBe("ready");
  });

  test("doctor exits non-zero but prints a parseable unhealthy report -> needs-you, not error (M8)", async () => {
    const exec: ExecScript = (argv) =>
      argv[2] === "doctor" ? { code: 1, stdout: JSON.stringify({ runtime: { ok: true }, extension: { loaded: false } }), stderr: "" } : ok();
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, fastBrowserSeams()), "tool.fast-browser");
    expect(r.status).toBe("needs-you");
  });

  test("doctor parse failure (no parseable payload) -> error with stderr head", async () => {
    const exec: ExecScript = (argv) => (argv[2] === "doctor" ? { code: 1, stdout: "", stderr: "boom\nmore detail" } : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, fastBrowserSeams()), "tool.fast-browser");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("boom");
  });

  test("doctor times out -> error", async () => {
    const exec: ExecScript = (argv) => (argv[2] === "doctor" ? { code: 124, stdout: "", stderr: "" } : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, fastBrowserSeams()), "tool.fast-browser");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("timed out");
  });
});

describe("toolRows — tool.editor", () => {
  test("no editors detected -> skipped, works-without-this note", async () => {
    const r = await pickRow(toolRows(fakeProbes(), [], { hasBrew: true }, NOOP_SEAMS), "tool.editor");
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("no editor found (works without this)");
    expect(r.required).toBe(false);
    expect(r.recheck).toBe("on-activate");
  });

  test("editors detected -> ready, names listed", async () => {
    const editors: DetectedEditor[] = [{ name: "Cursor", cliPath: "/x/cursor", appPath: "/Applications/Cursor.app" }];
    const seams: ToolsSeams = { ...NOOP_SEAMS, detectEditors: () => editors };
    const r = await pickRow(toolRows(fakeProbes(), [], { hasBrew: true }, seams), "tool.editor");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("Cursor");
  });
});

describe("toolRows — tool.chrome / tool.chrome-signin", () => {
  test("not required by any pack, not found -> missing, required false, on-activate", async () => {
    const p = fakeProbes({});
    const r = await pickRow(toolRows(p, [], { hasBrew: true }, NOOP_SEAMS), "tool.chrome");
    expect(r.status).toBe("missing");
    expect(r.required).toBe(false);
    expect(r.recheck).toBe("on-activate");
    expect(r.action).toEqual({ type: "open-url", label: "Download", url: "https://www.google.com/chrome/" });
  });

  test("required by a pack and found at /Applications -> ready, required true", async () => {
    const p = fakeProbes({ dirs: { "/Applications/Google Chrome.app": [] } });
    const reqs: PackRequirements[] = [{ pack: "somepack", tools: [], integrations: [], chrome: { required: true } }];
    const r = await pickRow(toolRows(p, reqs, { hasBrew: true }, NOOP_SEAMS), "tool.chrome");
    expect(r.status).toBe("ready");
    expect(r.required).toBe(true);
  });

  test("found under ~/Applications -> ready", async () => {
    const p = fakeProbes({ home: "/fake-home", dirs: { "/fake-home/Applications/Google Chrome.app": [] } });
    const r = await pickRow(toolRows(p, [], { hasBrew: true }, NOOP_SEAMS), "tool.chrome");
    expect(r.status).toBe("ready");
  });

  test("a pack declaring chrome.signedIntoApp adds tool.chrome-signin as needs-you, on-activate", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", tools: [], integrations: [], chrome: { required: true, signedIntoApp: "work@example.com" } }];
    const rows = await toolRows(fakeProbes(), reqs, { hasBrew: true }, NOOP_SEAMS);
    const r = rows.find((row) => row.id === "tool.chrome-signin");
    expect(r).toBeDefined();
    expect(r?.status).toBe("needs-you");
    expect(r?.detail).toContain("work@example.com");
    expect(r?.recheck).toBe("on-activate");
  });

  test("no pack declares chrome.signedIntoApp -> no tool.chrome-signin row", async () => {
    const rows = await toolRows(fakeProbes(), [], { hasBrew: true }, NOOP_SEAMS);
    expect(rows.find((row) => row.id === "tool.chrome-signin")).toBeUndefined();
  });
});

describe("toolRows — tool.mission-control", () => {
  test("Control+Up bound (enabled=1) -> needs-you, on-activate", async () => {
    const stdout = `{\n    32 = {\n        enabled = 1;\n        value = {\n            type = standard;\n        };\n    };\n}`;
    const exec: ExecScript = (argv) => (argv[0] === "defaults" ? ok(stdout) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.mission-control");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toBe("Control+Up is bound to Mission Control (rt nav uses it)");
    expect(r.action).toEqual({ type: "open-settings", label: "Open Keyboard Settings…", target: "keyboard" });
    expect(r.recheck).toBe("on-activate");
  });

  test("Control+Up unbound (enabled=0) -> ready", async () => {
    const stdout = `{\n    32 = {\n        enabled = 0;\n        value = {\n            type = standard;\n        };\n    };\n}`;
    const exec: ExecScript = (argv) => (argv[0] === "defaults" ? ok(stdout) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.mission-control");
    expect(r.status).toBe("ready");
  });

  test("key 32 absent entirely -> needs-you (R-T8-L1c: macOS's factory default binds it, absence is not free)", async () => {
    const stdout = `{\n    79 = {\n        enabled = 0;\n    };\n}`;
    const exec: ExecScript = (argv) => (argv[0] === "defaults" ? ok(stdout) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.mission-control");
    expect(r.status).toBe("needs-you");
  });

  test("key 32 present but its enabled field is missing -> needs-you (can't confirm unbound)", async () => {
    const stdout = `{\n    32 = {\n        value = {\n            type = standard;\n        };\n    };\n}`;
    const exec: ExecScript = (argv) => (argv[0] === "defaults" ? ok(stdout) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.mission-control");
    expect(r.status).toBe("needs-you");
  });

  test("the window can't bleed a neighbouring key's enabled into key 32's result", async () => {
    // key 32 has NO enabled field of its own; key 33 (right after it) is
    // enabled=0 — a leaky window would wrongly read 33's value as 32's.
    const stdout = `{\n    32 = {\n        value = {\n            type = standard;\n        };\n    };\n    33 = {\n        enabled = 0;\n    };\n}`;
    const exec: ExecScript = (argv) => (argv[0] === "defaults" ? ok(stdout) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.mission-control");
    expect(r.status).toBe("needs-you");
  });

  test("exec fails (non-timeout) -> skipped, not error", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "defaults" ? missing("defaults") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.mission-control");
    expect(r.status).toBe("skipped");
  });

  test("exec times out -> error, never skipped or needs-you", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "defaults" ? { code: 124, stdout: "", stderr: "" } : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.mission-control");
    expect(r.status).toBe("error");
  });
});

describe("toolRows — team-declared tool.team.<name>", () => {
  test("doppler missing with a brew formula declared -> missing, install action via brew, id namespaced (R-T8-L1a)", async () => {
    const reqs: PackRequirements[] = [
      { pack: "somepack", integrations: [], tools: [{ name: "doppler", why: "reads team secrets", install: { brew: "doppler" } }] },
    ];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "--version" ? missing("doppler") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "tool.team.doppler");
    expect(r.status).toBe("missing");
    expect(r.action).toEqual({ type: "install", label: "Install", tool: "doppler", via: "brew" });
    expect(r.required).toBe(true);
  });

  test("--version times out -> error", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "doppler", why: "reads team secrets" }] }];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "--version" ? { code: 124, stdout: "", stderr: "" } : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "tool.team.doppler");
    expect(r.status).toBe("error");
  });

  test("a team tool that collides with a built-in name (e.g. 'chrome') never overwrites the built-in row", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "chrome", why: "a pack-declared chrome helper" }] }];
    const exec: ExecScript = (argv) => (argv[0] === "chrome" && argv[1] === "--version" ? ok("1.0.0\n") : ok());
    const rows = await toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS);
    expect(rows.filter((r) => r.id === "tool.chrome")).toHaveLength(1);
    expect(rows.find((r) => r.id === "tool.team.chrome")?.status).toBe("ready");
  });

  test("declared optional -> required false, with a real optionalNote (L12)", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "ldcli", why: "reads flags", optional: true }] }];
    const exec: ExecScript = (argv) => (argv[0] === "ldcli" && argv[1] === "--version" ? missing("ldcli") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "tool.team.ldcli");
    expect(r.required).toBe(false);
    expect(r.optionalNote).not.toBeNull();
    expect(r.optionalNote).toContain("reads flags");
  });

  test("missing with no brew and an install url -> open-url action", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "sdm", why: "db tunnels", install: { url: "https://x/sdm" } }] }];
    const exec: ExecScript = (argv) => (argv[0] === "sdm" && argv[1] === "--version" ? missing("sdm") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: false }, NOOP_SEAMS), "tool.team.sdm");
    expect(r.action).toEqual({ type: "open-url", label: "Download", url: "https://x/sdm" });
  });

  test("missing with neither brew nor url -> steps action", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "widget", why: "does widget things" }] }];
    const exec: ExecScript = (argv) => (argv[0] === "widget" && argv[1] === "--version" ? missing("widget") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "tool.team.widget");
    expect(r.status).toBe("missing");
    expect(r.action?.type).toBe("steps");
  });

  test("present and above floor -> ready with version detail", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "doppler", why: "reads team secrets", floor: "3.0.0" }] }];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "--version" ? ok("3.5.0\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "tool.team.doppler");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("doppler 3.5.0");
  });

  test("present but below floor -> invalid, with an upgrade action (R-T7-b)", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "doppler", why: "reads team secrets", floor: "3.0.0", install: { brew: "doppler" } }] }];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "--version" ? ok("2.0.0\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "tool.team.doppler");
    expect(r.status).toBe("invalid");
    expect(r.action).toEqual({ type: "install", label: "Upgrade", tool: "doppler", via: "brew" });
  });

  test("below floor with no brew/url -> steps action naming the upgrade", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "widget", why: "does widget things", floor: "3.0.0" }] }];
    const exec: ExecScript = (argv) => (argv[0] === "widget" && argv[1] === "--version" ? ok("2.0.0\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "tool.team.widget");
    expect(r.status).toBe("invalid");
    expect(r.action).toEqual({ type: "steps", label: "Show steps…", steps: ["Upgrade widget to 3.0.0+", "Then re-run rt setup status"] });
  });

  test("a connect field on the requirement doesn't affect this row's readiness", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "doppler", why: "reads team secrets", connect: { integration: "doppler" } }] }];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "--version" ? ok("1.0.0\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "tool.team.doppler");
    expect(r.status).toBe("ready");
  });

  test("declared by two packs -> one row, first occurrence wins", async () => {
    const reqs: PackRequirements[] = [
      { pack: "a-pack", integrations: [], tools: [{ name: "doppler", why: "from a-pack" }] },
      { pack: "b-pack", integrations: [], tools: [{ name: "doppler", why: "from b-pack" }] },
    ];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "--version" ? ok("1.0.0\n") : ok());
    const rows = await toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS);
    expect(rows.filter((row) => row.id === "tool.team.doppler")).toHaveLength(1);
    expect(rows.find((row) => row.id === "tool.team.doppler")?.why).toBe("from a-pack");
  });
});

describe("toolRows — pack.<pack>", () => {
  test("plugin list contains pack@... -> ready, installed", async () => {
    const reqs: PackRequirements[] = [{ pack: "claimview", integrations: [], tools: [] }];
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "plugin" && argv[2] === "list" ? ok("claimview@assured\nother@team\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "pack.claimview");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("installed");
    expect(r.required).toBe(false);
    expect(r.optionalNote).not.toBeNull();
  });

  test("plugin list missing the pack -> missing, installed-by-Install detail", async () => {
    const reqs: PackRequirements[] = [{ pack: "claimview", integrations: [], tools: [] }];
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "plugin" && argv[2] === "list" ? ok("other@team\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "pack.claimview");
    expect(r.status).toBe("missing");
    expect(r.detail).toBe("installed by Install (plugins.install)");
  });

  test("a shorter pack name never matches as a substring of a longer one (L11)", async () => {
    const reqs: PackRequirements[] = [{ pack: "view", integrations: [], tools: [] }];
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "plugin" && argv[2] === "list" ? ok("claimview@assured\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "pack.view");
    expect(r.status).toBe("missing");
  });

  test("claude missing (127) -> skipped", async () => {
    const reqs: PackRequirements[] = [{ pack: "claimview", integrations: [], tools: [] }];
    const exec: ExecScript = (argv) => (argv[0] === "claude" ? missing("claude") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "pack.claimview");
    expect(r.status).toBe("skipped");
  });

  test("claude plugin list times out -> error, not skipped", async () => {
    const reqs: PackRequirements[] = [{ pack: "claimview", integrations: [], tools: [] }];
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "plugin" ? { code: 124, stdout: "", stderr: "" } : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "pack.claimview");
    expect(r.status).toBe("error");
  });

  test("a malformed pack's requirements.jsonc error surfaces as an error row, not silently dropped (R-T8-L1b)", async () => {
    const reqs: PackRequirements[] = [{ pack: "broken-pack", integrations: [], tools: [], error: "invalid JSON: Unexpected end of input" }];
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "plugin" && argv[2] === "list" ? ok("broken-pack@team\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "pack.broken-pack");
    expect(r.status).toBe("error");
    expect(r.detail).toBe("invalid JSON: Unexpected end of input");
  });

  test("one row per requirement entry", async () => {
    const reqs: PackRequirements[] = [
      { pack: "claimview", integrations: [], tools: [] },
      { pack: "other-pack", integrations: [], tools: [] },
    ];
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "plugin" ? ok("claimview@assured\n") : ok());
    const rows = await toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS);
    expect(rows.filter((row) => row.id.startsWith("pack."))).toHaveLength(2);
  });

  test("no pack requirements at all -> claude plugin list is never run (L11)", async () => {
    const p = fakeProbes({});
    await toolRows(p, [], { hasBrew: true }, NOOP_SEAMS);
    expect(p.calls.exec).not.toContainEqual(["claude", "plugin", "list"]);
  });
});
