import { describe, test, expect } from "bun:test";
import { toolRows } from "../validators/tools.ts";
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

async function pickRow(rowsP: ReturnType<typeof toolRows>, id: string) {
  const rows = await rowsP;
  const r = rows.find((row) => row.id === id);
  if (!r) throw new Error(`no row ${id}; got ids: ${rows.map((row) => row.id).join(", ")}`);
  return r;
}

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

  test("0.8.0 + integration status mentions claude -> ready", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "herdr" && argv[1] === "--version") return ok("0.8.0\n");
      if (argv[0] === "herdr" && argv[1] === "integration" && argv[2] === "status") return ok("claude: installed\n");
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("herdr 0.8.0, Claude integration installed");
    expect(r.required).toBe(true);
  });

  test("below floor -> invalid", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "herdr" && argv[1] === "--version" ? ok("0.7.4\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("invalid");
    expect(r.detail).toBe("herdr 0.7.4 < 0.7.5");
  });

  test("version ok but integration missing claude -> needs-you, run action", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "herdr" && argv[1] === "--version") return ok("0.9.0\n");
      if (argv[0] === "herdr" && argv[1] === "integration") return ok("no integrations installed\n");
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("needs-you");
    expect(r.action).toEqual({ type: "run", label: "Install integration", verb: ["tools", "setup", "herdr"] });
  });

  test("a real exec failure (not 127) -> error, never ready or invalid", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "herdr" && argv[1] === "--version" ? { code: 124, stdout: "", stderr: "" } : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("error");
  });
});

describe("toolRows — tool.claude", () => {
  test("127 -> missing, install action", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "--version" ? missing("claude") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("missing");
    expect(r.action).toEqual({ type: "install", label: "Install", tool: "claude", via: "brew" });
  });

  test("auth status exit 0 -> ready, signed in", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.2.3\n");
      if (argv[0] === "claude" && argv[1] === "auth" && argv[2] === "status") return ok("signed in as x\n");
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("ready");
  });

  test("auth status unknown subcommand (stderr mentions unknown) -> ready, sign-in not checked", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.2.3\n");
      if (argv[0] === "claude" && argv[1] === "auth") return { code: 1, stdout: "", stderr: "unknown command \"auth\"" };
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("installed (sign-in not checked)");
  });

  test("auth status known non-zero exit -> needs-you, sign in steps", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.2.3\n");
      if (argv[0] === "claude" && argv[1] === "auth") return { code: 1, stdout: "", stderr: "not logged in" };
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toBe("sign in: run claude once");
    expect(r.action).toEqual({ type: "steps", label: "Show steps…", steps: ["Open a terminal", "Run: claude", "Follow the sign-in prompt"] });
  });
});

describe("toolRows — tool.fast-browser", () => {
  test("exec null -> missing, bundled-link action", async () => {
    const r = await pickRow(toolRows(fakeProbes(), [], { hasBrew: true }, NOOP_SEAMS), "tool.fast-browser");
    expect(r.status).toBe("missing");
    expect(r.action).toEqual({ type: "link-bundled", label: "Use mattstack's", tool: "fast-browser" });
  });

  test("bundled exec [node, mjs] -> doctor invoked with the full argv, and extension not loaded -> needs-you with 3 steps", async () => {
    const seams: ToolsSeams = { ...NOOP_SEAMS, resolveTool: (_p, tool) => (tool === "fast-browser" ? { tool, bundled: "node", exec: ["node", "fast-browser.mjs"], userCopy: null, linked: false, chosen: "node" } : noopResolution(tool)) };
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
    const seams: ToolsSeams = { ...NOOP_SEAMS, resolveTool: (_p, tool) => (tool === "fast-browser" ? { tool, bundled: "node", exec: ["node", "fast-browser.mjs"], userCopy: null, linked: false, chosen: "node" } : noopResolution(tool)) };
    const exec: ExecScript = (argv) =>
      argv[2] === "doctor" ? ok(JSON.stringify({ runtime: { ok: true }, extension: { loaded: true }, pairing: { ok: true } })) : ok();
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, seams), "tool.fast-browser");
    expect(r.status).toBe("ready");
  });

  test("doctor parse failure -> error with stderr head", async () => {
    const seams: ToolsSeams = { ...NOOP_SEAMS, resolveTool: (_p, tool) => (tool === "fast-browser" ? { tool, bundled: "node", exec: ["node", "fast-browser.mjs"], userCopy: null, linked: false, chosen: "node" } : noopResolution(tool)) };
    const exec: ExecScript = (argv) => (argv[2] === "doctor" ? { code: 1, stdout: "", stderr: "boom\nmore detail" } : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, seams), "tool.fast-browser");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("boom");
  });
});

describe("toolRows — tool.editor", () => {
  test("no editors detected -> skipped, works-without-this note", async () => {
    const r = await pickRow(toolRows(fakeProbes(), [], { hasBrew: true }, NOOP_SEAMS), "tool.editor");
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("no editor found (works without this)");
    expect(r.required).toBe(false);
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
  test("not required by any pack, not found -> missing, required false", async () => {
    const p = fakeProbes({});
    const r = await pickRow(toolRows(p, [], { hasBrew: true }, NOOP_SEAMS), "tool.chrome");
    expect(r.status).toBe("missing");
    expect(r.required).toBe(false);
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

  test("a pack declaring chrome.signedIntoApp adds tool.chrome-signin as needs-you", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", tools: [], integrations: [], chrome: { required: true, signedIntoApp: "work@example.com" } }];
    const rows = await toolRows(fakeProbes(), reqs, { hasBrew: true }, NOOP_SEAMS);
    const r = rows.find((row) => row.id === "tool.chrome-signin");
    expect(r).toBeDefined();
    expect(r?.status).toBe("needs-you");
    expect(r?.detail).toContain("work@example.com");
  });

  test("no pack declares chrome.signedIntoApp -> no tool.chrome-signin row", async () => {
    const rows = await toolRows(fakeProbes(), [], { hasBrew: true }, NOOP_SEAMS);
    expect(rows.find((row) => row.id === "tool.chrome-signin")).toBeUndefined();
  });
});

describe("toolRows — tool.mission-control", () => {
  test("Control+Up bound (enabled=1) -> needs-you", async () => {
    const stdout = `{\n    32 = {\n        enabled = 1;\n        value = {\n            type = standard;\n        };\n    };\n}`;
    const exec: ExecScript = (argv) => (argv[0] === "defaults" ? ok(stdout) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.mission-control");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toBe("Control+Up is bound to Mission Control (rt nav uses it)");
    expect(r.action).toEqual({ type: "open-settings", label: "Open Keyboard Settings…", target: "keyboard" });
  });

  test("Control+Up unbound (enabled=0) -> ready", async () => {
    const stdout = `{\n    32 = {\n        enabled = 0;\n        value = {\n            type = standard;\n        };\n    };\n}`;
    const exec: ExecScript = (argv) => (argv[0] === "defaults" ? ok(stdout) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.mission-control");
    expect(r.status).toBe("ready");
  });

  test("exec fails -> skipped, not error", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "defaults" ? missing("defaults") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, NOOP_SEAMS), "tool.mission-control");
    expect(r.status).toBe("skipped");
  });
});

describe("toolRows — team-declared tool.<name>", () => {
  test("doppler missing with a brew formula declared -> missing, install action via brew", async () => {
    const reqs: PackRequirements[] = [
      { pack: "somepack", integrations: [], tools: [{ name: "doppler", why: "reads team secrets", install: { brew: "doppler" } }] },
    ];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "--version" ? missing("doppler") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "tool.doppler");
    expect(r.status).toBe("missing");
    expect(r.action).toEqual({ type: "install", label: "Install", tool: "doppler", via: "brew" });
    expect(r.required).toBe(true);
  });

  test("declared optional -> required false", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "ldcli", why: "reads flags", optional: true }] }];
    const exec: ExecScript = (argv) => (argv[0] === "ldcli" && argv[1] === "--version" ? missing("ldcli") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "tool.ldcli");
    expect(r.required).toBe(false);
  });

  test("missing with no brew and an install url -> open-url action", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "sdm", why: "db tunnels", install: { url: "https://x/sdm" } }] }];
    const exec: ExecScript = (argv) => (argv[0] === "sdm" && argv[1] === "--version" ? missing("sdm") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: false }, NOOP_SEAMS), "tool.sdm");
    expect(r.action).toEqual({ type: "open-url", label: "Download", url: "https://x/sdm" });
  });

  test("missing with neither brew nor url -> steps action", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "widget", why: "does widget things" }] }];
    const exec: ExecScript = (argv) => (argv[0] === "widget" && argv[1] === "--version" ? missing("widget") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "tool.widget");
    expect(r.status).toBe("missing");
    expect(r.action?.type).toBe("steps");
  });

  test("present and above floor -> ready with version detail", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "doppler", why: "reads team secrets", floor: "3.0.0" }] }];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "--version" ? ok("3.5.0\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "tool.doppler");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("doppler 3.5.0");
  });

  test("present but below floor -> invalid", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "doppler", why: "reads team secrets", floor: "3.0.0" }] }];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "--version" ? ok("2.0.0\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "tool.doppler");
    expect(r.status).toBe("invalid");
  });

  test("a connect field on the requirement doesn't affect this row's readiness", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "doppler", why: "reads team secrets", connect: { integration: "doppler" } }] }];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "--version" ? ok("1.0.0\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "tool.doppler");
    expect(r.status).toBe("ready");
  });

  test("declared by two packs -> one row, first occurrence wins", async () => {
    const reqs: PackRequirements[] = [
      { pack: "a-pack", integrations: [], tools: [{ name: "doppler", why: "from a-pack" }] },
      { pack: "b-pack", integrations: [], tools: [{ name: "doppler", why: "from b-pack" }] },
    ];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "--version" ? ok("1.0.0\n") : ok());
    const rows = await toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS);
    expect(rows.filter((row) => row.id === "tool.doppler")).toHaveLength(1);
    expect(rows.find((row) => row.id === "tool.doppler")?.why).toBe("from a-pack");
  });
});

describe("toolRows — pack.<pack>", () => {
  test("plugin list contains pack@... -> ready, installed", async () => {
    const reqs: PackRequirements[] = [{ pack: "acme", integrations: [], tools: [] }];
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "plugin" && argv[2] === "list" ? ok("acme@acme\nother@team\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "pack.acme");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("installed");
    expect(r.required).toBe(false);
    expect(r.optionalNote).not.toBeNull();
  });

  test("plugin list missing the pack -> missing, installed-by-Install detail", async () => {
    const reqs: PackRequirements[] = [{ pack: "acme", integrations: [], tools: [] }];
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "plugin" && argv[2] === "list" ? ok("other@team\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "pack.acme");
    expect(r.status).toBe("missing");
    expect(r.detail).toBe("installed by Install (plugins.install)");
  });

  test("claude missing (127) -> skipped", async () => {
    const reqs: PackRequirements[] = [{ pack: "acme", integrations: [], tools: [] }];
    const exec: ExecScript = (argv) => (argv[0] === "claude" ? missing("claude") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS), "pack.acme");
    expect(r.status).toBe("skipped");
  });

  test("one row per requirement entry", async () => {
    const reqs: PackRequirements[] = [
      { pack: "acme", integrations: [], tools: [] },
      { pack: "other-pack", integrations: [], tools: [] },
    ];
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "plugin" ? ok("acme@acme\n") : ok());
    const rows = await toolRows(fakeProbes({ exec }), reqs, { hasBrew: true }, NOOP_SEAMS);
    expect(rows.filter((row) => row.id.startsWith("pack."))).toHaveLength(2);
  });
});
