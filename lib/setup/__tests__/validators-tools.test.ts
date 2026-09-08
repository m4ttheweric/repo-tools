import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __test__ as bundleLayoutTest } from "../../bundle-layout.ts";
import { setSetting } from "../../settings/write.ts";
import { toolRows, extractVersion } from "../validators/tools.ts";
import type { ToolsSeams } from "../validators/tools.ts";
import { fakeProbes, ok, missing } from "./fakes.ts";
import type { ExecScript } from "./fakes.ts";
import type { PackRequirements } from "../requirements.ts";
import type { ToolResolution } from "../../deps/resolve.ts";
import type { DetectedEditor } from "../../editors.ts";
import type { ExecResult } from "../probes.ts";
import type { Row } from "../contract.ts";
import type { SecretPresence } from "../validators/accounts.ts";
import { PORTLESS_LAUNCHD_PLIST } from "../steps/services.ts";

// ─── ground truth, shaped from the real CLIs captured on 2026-09-03 ───
// The fixtures under ./fixtures/ preserve the captured shape exactly (every field,
// the nested mcpServers variants, the human form's chevron glyph and indentation);
// only values (names, paths) are sanitized for a public repo. Every plugin-list and
// doctor fixture below traces back to one of these three files rather than an
// invented shape: the two Critical defects this suite guards against both shipped
// because the old fixtures were invented and agreed with code that had never run
// against a real machine.

const FIXTURE_DIR = join(import.meta.dir, "fixtures");

/** Real `claude plugin list --json` shape: chat@mattstack, fast-browser@mattstack and mattstack@mattstack all enabled, plus other real plugins. */
const REAL_PLUGIN_LIST_JSON = readFileSync(join(FIXTURE_DIR, "plugin-list.json"), "utf8");
type RealPluginEntry = { id: string; enabled: boolean };
const REAL_PLUGIN_ENTRIES: RealPluginEntry[] = JSON.parse(REAL_PLUGIN_LIST_JSON);

/** Real `claude plugin list` (human form): a chevron glyph before each name, never the bare id. */
const REAL_PLUGIN_LIST_TXT = readFileSync(join(FIXTURE_DIR, "plugin-list.txt"), "utf8");

interface RealDoctorCheck {
  id: string;
  status: string;
  message: string;
  remediation: string | null;
}
interface RealDoctor {
  schemaVersion: number;
  ok: boolean;
  profile: string;
  checks: RealDoctorCheck[];
}

/** Real `fast-browser doctor --json` shape from a fully healthy machine: all 21 checks report "pass". */
const REAL_DOCTOR: RealDoctor = JSON.parse(readFileSync(join(FIXTURE_DIR, "doctor.json"), "utf8"));

function withCheckStatus(doctor: RealDoctor, id: string, status: string): RealDoctor {
  return { ...doctor, checks: doctor.checks.map((c) => (c.id === id ? { ...c, status } : c)) };
}

function withoutCheck(doctor: RealDoctor, id: string): RealDoctor {
  return { ...doctor, checks: doctor.checks.filter((c) => c.id !== id) };
}

function pluginListJsonWithout(...ids: string[]): string {
  return JSON.stringify(REAL_PLUGIN_ENTRIES.filter((e) => !ids.includes(e.id)));
}

function pluginListJsonWithDisabled(id: string): string {
  return JSON.stringify(REAL_PLUGIN_ENTRIES.map((e) => (e.id === id ? { ...e, enabled: false } : e)));
}

/** No bundled/user copy of anything, no detected editors — the safe default so a test that doesn't care about tool.fast-browser or tool.editor never touches the real machine's /Applications or a real bundle lookup. */
function noopResolution(tool: string): ToolResolution {
  return { tool, bundled: null, exec: null, userCopy: null, linked: false, chosen: null };
}

const NOOP_SEAMS: ToolsSeams = { resolveTool: (_p, tool) => noopResolution(tool), detectEditors: () => [] };
const NO_SECRETS: SecretPresence = { has: async () => null };
const HAS_KEY: SecretPresence = { has: async () => "lin_api_k" };

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
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("missing");
    expect(r.action).toEqual({ type: "install", label: "Install", tool: "herdr", via: "brew" });
  });

  test("127 with no brew -> install action via vendor", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "herdr" && argv[1] === "--version" ? missing("herdr") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: false, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.herdr");
    expect(r.action).toEqual({ type: "install", label: "Install", tool: "herdr", via: "vendor" });
  });

  test("--version times out -> error, never missing/needs-you", async () => {
    const r = await pickRow(toolRows(fakeProbes({ exec: TIMEOUT }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.herdr");
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
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.herdr");
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
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toBe("herdr 0.9.0, Claude integration not installed");
    expect(r.action).toEqual({ type: "run", label: "Install integration", verb: ["tools", "setup", "herdr"] });
    // Install's own herdr.integration step adds it — the binary gates Install, the integration never.
    expect(r.required).toBe(false);
    expect(r.optionalNote).toContain("Install");
  });

  test("the claude line is entirely absent -> error, never a determined negative", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "herdr" && argv[1] === "--version") return ok("0.9.0\n");
      if (argv[0] === "herdr" && argv[1] === "integration") return ok("codex: current (v7) (/x)\n");
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("error");
  });

  test("integration status times out -> error", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "herdr" && argv[1] === "--version") return ok("0.9.0\n");
      if (argv[0] === "herdr" && argv[1] === "integration") return { code: 124, stdout: "", stderr: "" };
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("error");
  });

  test("integration status a hard failure (non-0, non-124) -> error", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "herdr" && argv[1] === "--version") return ok("0.9.0\n");
      if (argv[0] === "herdr" && argv[1] === "integration") return { code: 1, stdout: "", stderr: "boom" };
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("error");
  });

  test("below floor -> invalid, with an upgrade action (R-T7-b, no dead end)", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "herdr" && argv[1] === "--version" ? ok("0.7.4\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.herdr");
    expect(r.status).toBe("invalid");
    expect(r.detail).toBe("herdr 0.7.4 < 0.7.5");
    expect(r.action).toEqual({ type: "install", label: "Upgrade", tool: "herdr", via: "brew" });
  });
});

describe("toolRows — tool.claude", () => {
  test("127 -> missing, install action", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "--version" ? missing("claude") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("missing");
    expect(r.action).toEqual({ type: "install", label: "Install", tool: "claude", via: "brew" });
    expect(r.recheck).toBe("on-activate");
  });

  test("--version times out -> error", async () => {
    const r = await pickRow(toolRows(fakeProbes({ exec: TIMEOUT }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("error");
  });

  test("auth status JSON loggedIn:true -> ready, signed in (never trusts exit 0 alone)", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.2.3\n");
      if (argv[0] === "claude" && argv[1] === "auth" && argv[2] === "status") return ok(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("claude 1.2.3, signed in");
  });

  test("auth status JSON loggedIn:false, exit 0 -> needs-you (M2: exit 0 is not proof of sign-in)", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.2.3\n");
      if (argv[0] === "claude" && argv[1] === "auth") return ok(JSON.stringify({ loggedIn: false }));
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toBe("sign in: run claude once");
    expect(r.action).toEqual({ type: "steps", label: "Show steps…", steps: ["Open a terminal", "Run: claude", "Follow the sign-in prompt"] });
    // Sign-in is an interactive step after Install; the binary gates Install, the sign-in never.
    expect(r.required).toBe(false);
    expect(r.optionalNote).toContain("after Install");
  });

  test("auth status unknown subcommand (stderr mentions unknown) -> needs-you, sign-in not checked — never a guessed ready (H-1)", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.2.3\n");
      if (argv[0] === "claude" && argv[1] === "auth") return { code: 1, stdout: "", stderr: "unknown command \"auth\"" };
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.claude");
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
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("sign-in could not be checked");
  });

  test("auth status known non-zero exit, non-JSON -> needs-you, sign in steps", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.2.3\n");
      if (argv[0] === "claude" && argv[1] === "auth") return { code: 1, stdout: "", stderr: "not logged in" };
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toBe("sign in: run claude once");
  });

  test("auth status times out -> error", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.2.3\n");
      if (argv[0] === "claude" && argv[1] === "auth") return { code: 124, stdout: "", stderr: "" };
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("error");
  });

  test("auth status exits 0 with an unparseable, non-'unknown' response -> error (can't determine)", async () => {
    const exec: ExecScript = (argv) => {
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.2.3\n");
      if (argv[0] === "claude" && argv[1] === "auth") return ok("garbled non-json output");
      return ok();
    };
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.claude");
    expect(r.status).toBe("error");
  });
});

describe("toolRows — tool.fast-browser", () => {
  test("not resolvable -> missing with the link-bundled action, and this is the one state that gates", async () => {
    const r = await pickRow(toolRows(fakeProbes(), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.fast-browser");
    expect(r.status).toBe("missing");
    expect(r.required).toBe(true);
    expect(r.action).toEqual({ type: "link-bundled", label: "Use mattstack's", tool: "fast-browser" });
  });

  function fastBrowserSeams(): ToolsSeams {
    return { ...NOOP_SEAMS, resolveTool: (_p, tool) => (tool === "fast-browser" ? { tool, bundled: "node", exec: ["node", "fast-browser.mjs"], userCopy: null, linked: false, chosen: "node" } : noopResolution(tool)) };
  }

  /** Feeds `report` back as doctor's JSON envelope. */
  function doctorExec(report: unknown, code = 0): ExecScript {
    return (argv) => (argv[2] === "doctor" && argv[3] === "--json" ? { code, stdout: JSON.stringify(report), stderr: "" } : ok());
  }

  test("real fully healthy envelope -> ready, and doctor ran through the resolved exec (C2)", async () => {
    const p = fakeProbes({ exec: doctorExec(REAL_DOCTOR) });
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, fastBrowserSeams()), "tool.fast-browser");
    expect(p.calls.exec).toContainEqual(["node", "fast-browser.mjs", "doctor", "--json"]);
    expect(r.status).toBe("ready");
  });

  // The runtime is created by the fastbrowser.setup Install step, so before
  // Install it cannot exist and no checklist action can create it. A required
  // row here left canInstall false forever on any Mac with Chrome.
  test("runtime-checksum check fails does not gate, even with Chrome installed", async () => {
    const p = fakeProbes({ exec: doctorExec(withCheckStatus(REAL_DOCTOR, "runtime-checksum", "fail")) });
    p.mkdirp("/Applications/Google Chrome.app");
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, fastBrowserSeams()), "tool.fast-browser");
    expect(r.status).toBe("needs-you");
    expect(r.required).toBe(false);
    expect(r.optionalNote).toBe("Installed by Install (fastbrowser.setup).");
    expect(r.action).toEqual({ type: "run", label: "Run setup", verb: ["tools", "setup", "fast-browser"] });
  });

  // An id this build doesn't recognize (an older or newer fast-browser) is
  // not proof the runtime is broken: rt just couldn't determine the answer,
  // so it must never read as the same "not ready" a real fail reads as.
  test("runtime-checksum check absent from the report -> error, not a guessed needs-you", async () => {
    const p = fakeProbes({ exec: doctorExec(withoutCheck(REAL_DOCTOR, "runtime-checksum")) });
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, fastBrowserSeams()), "tool.fast-browser");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("runtime-checksum");
    expect(r.required).toBe(false);
  });

  test("doctor exits non-zero but prints a parseable healthy report -> ready, not error (M8)", async () => {
    const p = fakeProbes({ exec: doctorExec(REAL_DOCTOR, 1) });
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, fastBrowserSeams()), "tool.fast-browser");
    expect(r.status).toBe("ready");
  });

  test("doctor parse failure -> error with the stderr head, and still does not gate", async () => {
    const exec: ExecScript = (argv) => (argv[2] === "doctor" ? { code: 1, stdout: "", stderr: "boom\nmore detail" } : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, fastBrowserSeams()), "tool.fast-browser");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("boom");
    expect(r.required).toBe(false);
  });

  test("doctor times out -> error, and still does not gate", async () => {
    const r = await pickRow(toolRows(fakeProbes({ exec: TIMEOUT }), [], { hasBrew: true, secrets: NO_SECRETS }, fastBrowserSeams()), "tool.fast-browser");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("timed out");
    expect(r.required).toBe(false);
  });

  test("one doctor run feeds both rows", async () => {
    const p = fakeProbes({ exec: doctorExec(REAL_DOCTOR) });
    p.mkdirp("/Applications/Google Chrome.app");
    const rows = await toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, fastBrowserSeams());
    expect(rows.map((r) => r.id)).toContain("tool.fast-browser-extension");
    expect(p.calls.exec.filter((argv) => argv[2] === "doctor").length).toBe(1);
  });
});

describe("toolRows - tool.fast-browser-extension", () => {
  function fastBrowserSeams(): ToolsSeams {
    return { ...NOOP_SEAMS, resolveTool: (_p, tool) => (tool === "fast-browser" ? { tool, bundled: "node", exec: ["node", "fast-browser.mjs"], userCopy: null, linked: false, chosen: "node" } : noopResolution(tool)) };
  }
  function doctorExec(report: unknown): ExecScript {
    return (argv) => (argv[2] === "doctor" && argv[3] === "--json" ? ok(JSON.stringify(report)) : ok());
  }
  function withChrome(exec: ExecScript) {
    const p = fakeProbes({ exec });
    p.mkdirp("/Applications/Google Chrome.app");
    return p;
  }

  test("no Chrome -> skipped, nothing to load it into", async () => {
    const p = fakeProbes({ exec: doctorExec(REAL_DOCTOR) });
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, fastBrowserSeams()), "tool.fast-browser-extension");
    expect(r.status).toBe("skipped");
    expect(r.required).toBe(false);
  });

  test("extension-loaded check fails -> needs-you with steps that end in pairing", async () => {
    const p = withChrome(doctorExec(withCheckStatus(REAL_DOCTOR, "extension-loaded", "fail")));
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, fastBrowserSeams()), "tool.fast-browser-extension");
    expect(r.status).toBe("needs-you");
    expect(r.required).toBe(false);
    expect(r.action?.type).toBe("steps");
    const steps = (r.action as { steps: string[] }).steps;
    expect(steps[0]).toContain("chrome://extensions");
    expect(steps.join(" ")).toContain("reconnect token");
  });

  // doctor's own "pairing" check already passes whenever the connection mode
  // isn't auto (the documented default). Manual connection is the documented
  // default, so a manually connected machine is healthy. This row reports the
  // check's status rather than inventing an additional rule.
  test("extension-loaded passes but pairing check fails -> needs-you with pairing-only steps", async () => {
    const p = withChrome(doctorExec(withCheckStatus(REAL_DOCTOR, "pairing", "fail")));
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, fastBrowserSeams()), "tool.fast-browser-extension");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("not paired");
    const steps = (r.action as { steps: string[] }).steps;
    expect(steps.join(" ")).not.toContain("chrome://extensions");
    expect(steps.join(" ")).toContain("reconnect token");
  });

  test("real fully healthy envelope -> ready (C2: both Fast Browser rows read ready)", async () => {
    const p = withChrome(doctorExec(REAL_DOCTOR));
    const rows = await toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, fastBrowserSeams());
    expect(rows.find((r) => r.id === "tool.fast-browser")?.status).toBe("ready");
    expect(rows.find((r) => r.id === "tool.fast-browser-extension")?.status).toBe("ready");
  });

  test("extension-loaded check absent from the report -> error, not a false ready or a false accusation", async () => {
    const p = withChrome(doctorExec(withoutCheck(REAL_DOCTOR, "extension-loaded")));
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, fastBrowserSeams()), "tool.fast-browser-extension");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("extension-loaded");
  });

  test("pairing check absent from the report -> error, not a false ready or a false accusation", async () => {
    const p = withChrome(doctorExec(withoutCheck(REAL_DOCTOR, "pairing")));
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, fastBrowserSeams()), "tool.fast-browser-extension");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("pairing");
  });

  // tool.fast-browser already reports an unreadable doctor; two rows for one
  // fact would just double the noise.
  test("doctor unreadable -> skipped, deferring to the Fast Browser row", async () => {
    const p = withChrome(() => ({ code: 1, stdout: "", stderr: "boom" }));
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, fastBrowserSeams()), "tool.fast-browser-extension");
    expect(r.status).toBe("skipped");
  });
});

describe("toolRows — well-formed-JSON-but-wrong-shape doctor payloads: no throw, honest could-not-read path", () => {
  function fastBrowserSeams(): ToolsSeams {
    return { ...NOOP_SEAMS, resolveTool: (_p, tool) => (tool === "fast-browser" ? { tool, bundled: "node", exec: ["node", "fast-browser.mjs"], userCopy: null, linked: false, chosen: "node" } : noopResolution(tool)) };
  }
  function doctorExec(report: unknown): ExecScript {
    return (argv) => (argv[2] === "doctor" && argv[3] === "--json" ? ok(JSON.stringify(report)) : ok());
  }
  function withChrome(exec: ExecScript) {
    const p = fakeProbes({ exec });
    p.mkdirp("/Applications/Google Chrome.app");
    return p;
  }

  async function assertCouldNotBeRead(report: unknown) {
    const rows = await toolRows(withChrome(doctorExec(report)), [], { hasBrew: true, secrets: NO_SECRETS }, fastBrowserSeams());
    const main = rows.find((r) => r.id === "tool.fast-browser")!;
    expect(main.status).toBe("error");
    const extension = rows.find((r) => r.id === "tool.fast-browser-extension")!;
    expect(extension.status).toBe("skipped");
    expect(extension.detail).toBe("fast-browser doctor could not be read (see Fast Browser)");
  }

  // `checks` present but not an array at all: {}.find is not a function is
  // the exact throw this shape used to cause.
  test("checks is an object, not an array -> could-not-read on both rows, never a thrown TypeError", async () => {
    await assertCouldNotBeRead({ checks: {} });
  });

  test("checks is an array whose element is null -> could-not-read on both rows", async () => {
    await assertCouldNotBeRead({ checks: [null] });
  });

  test("checks is an array whose element has no string id -> could-not-read on both rows", async () => {
    await assertCouldNotBeRead({ checks: [{ status: "pass" }] });
  });

  test("valid fixture is unaffected by the shape hardening (regression guard)", async () => {
    const rows = await toolRows(withChrome(doctorExec(REAL_DOCTOR)), [], { hasBrew: true, secrets: NO_SECRETS }, fastBrowserSeams());
    expect(rows.find((r) => r.id === "tool.fast-browser")?.status).toBe("ready");
    expect(rows.find((r) => r.id === "tool.fast-browser-extension")?.status).toBe("ready");
  });
});

describe("toolRows - tool.plugins", () => {
  function listExec(result: ExecResult): ExecScript {
    return (argv) => (argv[0] === "claude" && argv[1] === "plugin" && argv[2] === "list" ? result : ok());
  }

  test("real plugin listing, all three baseline plugins present and enabled -> ready", async () => {
    const r = await pickRow(toolRows(fakeProbes({ exec: listExec(ok(REAL_PLUGIN_LIST_JSON)) }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.plugins");
    expect(r.status).toBe("ready");
    expect(r.required).toBe(false);
    expect(r.optionalNote).toBe("Installed by Install (plugins.install).");
  });

  // `claude plugin list` (no flag) prints "  ❯ chat@mattstack", never the
  // bare id, so feeding that real human-format output through must never be
  // silently read as "no plugins" (missing) or "ready"; it can't be parsed as
  // JSON at all, so it reads as the one status that says rt could not tell.
  test("real human-format listing text (no --json) -> error, never a silent empty-install read (C1)", async () => {
    const r = await pickRow(toolRows(fakeProbes({ exec: listExec(ok(REAL_PLUGIN_LIST_TXT)) }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.plugins");
    expect(r.status).toBe("error");
    expect(r.status).not.toBe("missing");
    expect(r.status).not.toBe("ready");
  });

  test("chat missing from the real listing -> missing, naming only what is absent", async () => {
    const list = pluginListJsonWithout("chat@mattstack");
    const r = await pickRow(toolRows(fakeProbes({ exec: listExec(ok(list)) }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.plugins");
    expect(r.status).toBe("missing");
    expect(r.detail).toContain("chat@mattstack");
    expect(r.detail).not.toContain("fast-browser@mattstack");
    expect(r.action).toEqual({ type: "run", label: "Install plugins", verb: ["setup", "pack"] });
  });

  // Matched by the parsed `id` field against an exact key, never a substring:
  // an id that merely starts with the same text as a baseline plugin's id
  // must not satisfy it.
  test("an id that only shares a prefix with a baseline entry does not count", async () => {
    const entries = REAL_PLUGIN_ENTRIES.filter((e) => e.id !== "chat@mattstack").concat([{ id: "chat@mattstack-fork", enabled: true } as { id: string; enabled: boolean }]);
    const r = await pickRow(toolRows(fakeProbes({ exec: listExec(ok(JSON.stringify(entries))) }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.plugins");
    expect(r.status).toBe("missing");
    expect(r.detail).toContain("chat@mattstack");
  });

  // `plugins.install` only enables a plugin best-effort, and disabling a
  // plugin is a deliberate user choice: an installed but disabled baseline
  // plugin is inert, so verify names it and nags, but it must never read as
  // a broken install (that would make it critical in status mode).
  test("every baseline plugin present but one is disabled -> needs-you, naming it, with an enable action", async () => {
    const list = pluginListJsonWithDisabled("fast-browser@mattstack");
    const r = await pickRow(toolRows(fakeProbes({ exec: listExec(ok(list)) }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.plugins");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("fast-browser@mattstack");
    expect(r.action).toEqual({ type: "run", label: "Enable plugins", verb: ["setup", "pack"] });
  });

  test("claude not installed -> skipped", async () => {
    const r = await pickRow(toolRows(fakeProbes({ exec: listExec(missing("claude")) }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.plugins");
    expect(r.status).toBe("skipped");
  });

  test("claude plugin list times out -> error", async () => {
    const r = await pickRow(toolRows(fakeProbes({ exec: listExec({ code: 124, stdout: "", stderr: "" }) }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.plugins");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("timed out");
  });

  // A crashed or misconfigured CLI is a real failure this row could not see
  // past; "skipped" would read as "nothing to check here", which it is not.
  test("claude plugin list fails for any other reason -> error, not skipped", async () => {
    const r = await pickRow(toolRows(fakeProbes({ exec: listExec({ code: 3, stdout: "", stderr: "boom" }) }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.plugins");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("exit 3");
  });

  test("claude plugin list runs once for tool.plugins and the pack rows together", async () => {
    const p = fakeProbes({ exec: listExec(ok(REAL_PLUGIN_LIST_JSON)) });
    const reqs: PackRequirements[] = [{ pack: "acme", tools: [], integrations: [] }];
    await toolRows(p, reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS);
    expect(p.calls.exec.filter((argv) => argv[1] === "plugin" && argv[2] === "list").length).toBe(1);
  });
});

describe("toolRows — well-formed-JSON-but-wrong-shape plugin list payloads: no throw, honest error path", () => {
  function listExec(result: ExecResult): ExecScript {
    return (argv) => (argv[0] === "claude" && argv[1] === "plugin" && argv[2] === "list" ? result : ok());
  }

  async function assertErrorPath(stdout: string) {
    const reqs: PackRequirements[] = [{ pack: "acme", integrations: [], tools: [] }];
    const rows = await toolRows(fakeProbes({ exec: listExec(ok(stdout)) }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS);
    const plugins = rows.find((r) => r.id === "tool.plugins")!;
    expect(plugins.status).toBe("error");
    expect(plugins.detail).toBe("claude plugin list --json output could not be read");
    const pack = rows.find((r) => r.id === "pack.acme")!;
    expect(pack.status).toBe("error");
    expect(pack.detail).toBe("claude plugin list --json output could not be read");
  }

  // `entries.map((e) => [e.id, e])` and `.some((e) => ... e.id ...)` both read
  // `id` off whatever `[null]` hands them — this is the exact throw source.
  test("[null] -> error path on tool.plugins and every pack row, never a thrown TypeError", async () => {
    await assertErrorPath(JSON.stringify([null]));
  });

  test("an element with no string id -> error path", async () => {
    await assertErrorPath(JSON.stringify([{ enabled: true }]));
  });

  test("top level is an object, not an array -> error path", async () => {
    await assertErrorPath(JSON.stringify({ plugins: [] }));
  });

  test("valid fixture is unaffected by the shape hardening (regression guard)", async () => {
    const reqs: PackRequirements[] = [{ pack: "acme", integrations: [], tools: [] }];
    const rows = await toolRows(fakeProbes({ exec: listExec(ok(REAL_PLUGIN_LIST_JSON)) }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS);
    expect(rows.find((r) => r.id === "tool.plugins")?.status).toBe("ready");
  });
});

describe("toolRows — tool.editor", () => {
  test("no editors detected -> skipped, works-without-this note", async () => {
    const r = await pickRow(toolRows(fakeProbes(), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.editor");
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("no editor found (works without this)");
    expect(r.required).toBe(false);
    expect(r.recheck).toBe("on-activate");
  });

  test("editors detected -> ready, names listed", async () => {
    const editors: DetectedEditor[] = [{ name: "Cursor", cliPath: "/x/cursor", appPath: "/Applications/Cursor.app" }];
    const seams: ToolsSeams = { ...NOOP_SEAMS, detectEditors: () => editors };
    const r = await pickRow(toolRows(fakeProbes(), [], { hasBrew: true, secrets: NO_SECRETS }, seams), "tool.editor");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("Cursor");
  });
});

describe("toolRows — tool.chrome / tool.chrome-signin", () => {
  test("not required by any pack, not found -> missing, required false, on-activate", async () => {
    const p = fakeProbes({});
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.chrome");
    expect(r.status).toBe("missing");
    expect(r.required).toBe(false);
    expect(r.recheck).toBe("on-activate");
    expect(r.action).toEqual({ type: "open-url", label: "Download", url: "https://www.google.com/chrome/" });
  });

  test("required by a pack and found at /Applications -> ready, required true", async () => {
    const p = fakeProbes({ dirs: { "/Applications/Google Chrome.app": [] } });
    const reqs: PackRequirements[] = [{ pack: "somepack", tools: [], integrations: [], chrome: { required: true } }];
    const r = await pickRow(toolRows(p, reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.chrome");
    expect(r.status).toBe("ready");
    expect(r.required).toBe(true);
  });

  test("found under ~/Applications -> ready", async () => {
    const p = fakeProbes({ home: "/fake-home", dirs: { "/fake-home/Applications/Google Chrome.app": [] } });
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.chrome");
    expect(r.status).toBe("ready");
  });

  test("a pack declaring chrome.signedIntoApp adds tool.chrome-signin as needs-you, on-activate", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", tools: [], integrations: [], chrome: { required: true, signedIntoApp: "work@example.com" } }];
    const rows = await toolRows(fakeProbes(), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS);
    const r = rows.find((row) => row.id === "tool.chrome-signin");
    expect(r).toBeDefined();
    expect(r?.status).toBe("needs-you");
    expect(r?.detail).toContain("work@example.com");
    expect(r?.recheck).toBe("on-activate");
  });

  test("no pack declares chrome.signedIntoApp -> no tool.chrome-signin row", async () => {
    const rows = await toolRows(fakeProbes(), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS);
    expect(rows.find((row) => row.id === "tool.chrome-signin")).toBeUndefined();
  });
});

describe("toolRows — tool.mission-control", () => {
  test("Control+Up bound (enabled=1) -> needs-you, on-activate", async () => {
    const stdout = `{\n    32 = {\n        enabled = 1;\n        value = {\n            type = standard;\n        };\n    };\n}`;
    const exec: ExecScript = (argv) => (argv[0] === "defaults" ? ok(stdout) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.mission-control");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toBe("Control+Up is bound to Mission Control (rt nav uses it)");
    expect(r.action).toEqual({ type: "open-settings", label: "Open Keyboard Settings…", target: "keyboard" });
    expect(r.recheck).toBe("on-activate");
  });

  test("Control+Up unbound (enabled=0) -> ready", async () => {
    const stdout = `{\n    32 = {\n        enabled = 0;\n        value = {\n            type = standard;\n        };\n    };\n}`;
    const exec: ExecScript = (argv) => (argv[0] === "defaults" ? ok(stdout) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.mission-control");
    expect(r.status).toBe("ready");
  });

  test("key 32 absent entirely -> needs-you (R-T8-L1c: macOS's factory default binds it, absence is not free)", async () => {
    const stdout = `{\n    79 = {\n        enabled = 0;\n    };\n}`;
    const exec: ExecScript = (argv) => (argv[0] === "defaults" ? ok(stdout) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.mission-control");
    expect(r.status).toBe("needs-you");
  });

  test("key 32 present but its enabled field is missing -> needs-you (can't confirm unbound)", async () => {
    const stdout = `{\n    32 = {\n        value = {\n            type = standard;\n        };\n    };\n}`;
    const exec: ExecScript = (argv) => (argv[0] === "defaults" ? ok(stdout) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.mission-control");
    expect(r.status).toBe("needs-you");
  });

  test("the window can't bleed a neighbouring key's enabled into key 32's result", async () => {
    // key 32 has NO enabled field of its own; key 33 (right after it) is
    // enabled=0 — a leaky window would wrongly read 33's value as 32's.
    const stdout = `{\n    32 = {\n        value = {\n            type = standard;\n        };\n    };\n    33 = {\n        enabled = 0;\n    };\n}`;
    const exec: ExecScript = (argv) => (argv[0] === "defaults" ? ok(stdout) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.mission-control");
    expect(r.status).toBe("needs-you");
  });

  test("exec fails (non-timeout) -> skipped, not error", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "defaults" ? missing("defaults") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.mission-control");
    expect(r.status).toBe("skipped");
  });

  test("exec times out -> error, never skipped or needs-you", async () => {
    const exec: ExecScript = (argv) => (argv[0] === "defaults" ? { code: 124, stdout: "", stderr: "" } : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.mission-control");
    expect(r.status).toBe("error");
  });
});

describe("toolRows — team-declared tool.team.<name>", () => {
  test("doppler missing with a brew formula declared -> missing, install action via brew, id namespaced (R-T8-L1a)", async () => {
    const reqs: PackRequirements[] = [
      { pack: "somepack", integrations: [], tools: [{ name: "doppler", why: "reads team secrets", install: { brew: "doppler" } }] },
    ];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "--version" ? missing("doppler") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.team.doppler");
    expect(r.status).toBe("missing");
    expect(r.action).toEqual({ type: "install", label: "Install", tool: "doppler", via: "brew" });
    expect(r.required).toBe(true);
  });

  test("--version times out -> error", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "doppler", why: "reads team secrets" }] }];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "--version" ? { code: 124, stdout: "", stderr: "" } : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.team.doppler");
    expect(r.status).toBe("error");
  });

  test("a team tool that collides with a built-in name (e.g. 'chrome') never overwrites the built-in row", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "chrome", why: "a pack-declared chrome helper" }] }];
    const exec: ExecScript = (argv) => (argv[0] === "chrome" && argv[1] === "--version" ? ok("1.0.0\n") : ok());
    const rows = await toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS);
    expect(rows.filter((r) => r.id === "tool.chrome")).toHaveLength(1);
    expect(rows.find((r) => r.id === "tool.team.chrome")?.status).toBe("ready");
  });

  test("declared optional -> required false, with a real optionalNote (L12)", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "ldcli", why: "reads flags", optional: true }] }];
    const exec: ExecScript = (argv) => (argv[0] === "ldcli" && argv[1] === "--version" ? missing("ldcli") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.team.ldcli");
    expect(r.required).toBe(false);
    expect(r.optionalNote).not.toBeNull();
    expect(r.optionalNote).toContain("reads flags");
  });

  test("missing with no brew and an install url -> open-url action", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "sdm", why: "db tunnels", install: { url: "https://x/sdm" } }] }];
    const exec: ExecScript = (argv) => (argv[0] === "sdm" && argv[1] === "--version" ? missing("sdm") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: false, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.team.sdm");
    expect(r.action).toEqual({ type: "open-url", label: "Download", url: "https://x/sdm" });
  });

  test("missing with neither brew nor url -> steps action", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "widget", why: "does widget things" }] }];
    const exec: ExecScript = (argv) => (argv[0] === "widget" && argv[1] === "--version" ? missing("widget") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.team.widget");
    expect(r.status).toBe("missing");
    expect(r.action?.type).toBe("steps");
  });

  test("present and above floor -> ready with version detail", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "doppler", why: "reads team secrets", floor: "3.0.0" }] }];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "--version" ? ok("3.5.0\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.team.doppler");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("doppler 3.5.0");
  });

  test("present but below floor -> invalid, with an upgrade action (R-T7-b)", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "doppler", why: "reads team secrets", floor: "3.0.0", install: { brew: "doppler" } }] }];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "--version" ? ok("2.0.0\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.team.doppler");
    expect(r.status).toBe("invalid");
    expect(r.action).toEqual({ type: "install", label: "Upgrade", tool: "doppler", via: "brew" });
  });

  test("below floor with no brew/url -> steps action naming the upgrade", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "widget", why: "does widget things", floor: "3.0.0" }] }];
    const exec: ExecScript = (argv) => (argv[0] === "widget" && argv[1] === "--version" ? ok("2.0.0\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.team.widget");
    expect(r.status).toBe("invalid");
    expect(r.action).toEqual({ type: "steps", label: "Show steps…", steps: ["Upgrade widget to 3.0.0+", "Then re-run rt setup status"] });
  });

  test("a connect field on the requirement doesn't affect this row's readiness", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [{ name: "doppler", why: "reads team secrets", connect: { integration: "doppler" } }] }];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "--version" ? ok("1.0.0\n") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.team.doppler");
    expect(r.status).toBe("ready");
  });

  test("declared by two packs -> one row, first occurrence wins", async () => {
    const reqs: PackRequirements[] = [
      { pack: "a-pack", integrations: [], tools: [{ name: "doppler", why: "from a-pack" }] },
      { pack: "b-pack", integrations: [], tools: [{ name: "doppler", why: "from b-pack" }] },
    ];
    const exec: ExecScript = (argv) => (argv[0] === "doppler" && argv[1] === "--version" ? ok("1.0.0\n") : ok());
    const rows = await toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS);
    expect(rows.filter((row) => row.id === "tool.team.doppler")).toHaveLength(1);
    expect(rows.find((row) => row.id === "tool.team.doppler")?.why).toBe("from a-pack");
  });
});

describe("toolRows — pack.<pack>", () => {
  test("real plugin listing contains the pack's id -> ready, installed", async () => {
    const reqs: PackRequirements[] = [{ pack: "beta", integrations: [], tools: [] }];
    const listWithBeta = JSON.stringify([...REAL_PLUGIN_ENTRIES, { id: "beta@acme-market", enabled: true }]);
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "plugin" && argv[2] === "list" ? ok(listWithBeta) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "pack.beta");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("installed");
    expect(r.required).toBe(false);
    expect(r.optionalNote).not.toBeNull();
  });

  test("real plugin listing does not contain the pack -> missing, installed-by-Install detail", async () => {
    const reqs: PackRequirements[] = [{ pack: "acme", integrations: [], tools: [] }];
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "plugin" && argv[2] === "list" ? ok(REAL_PLUGIN_LIST_JSON) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "pack.acme");
    expect(r.status).toBe("missing");
    expect(r.detail).toBe("installed by Install (plugins.install)");
  });

  // The real listing has "fast-browser@mattstack" but nothing with the exact
  // prefix "fast@": a pack name that only shares a prefix with a longer real
  // id must never match it.
  test("a shorter pack name never matches as a prefix of a longer real id (L11)", async () => {
    const reqs: PackRequirements[] = [{ pack: "fast", integrations: [], tools: [] }];
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "plugin" && argv[2] === "list" ? ok(REAL_PLUGIN_LIST_JSON) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "pack.fast");
    expect(r.status).toBe("missing");
  });

  test("claude missing (127) -> skipped", async () => {
    const reqs: PackRequirements[] = [{ pack: "acme", integrations: [], tools: [] }];
    const exec: ExecScript = (argv) => (argv[0] === "claude" ? missing("claude") : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "pack.acme");
    expect(r.status).toBe("skipped");
  });

  test("claude plugin list times out -> error, not skipped", async () => {
    const reqs: PackRequirements[] = [{ pack: "acme", integrations: [], tools: [] }];
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "plugin" ? { code: 124, stdout: "", stderr: "" } : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "pack.acme");
    expect(r.status).toBe("error");
  });

  // Real human-format output (no --json) can't be parsed as an entry array,
  // so it must read as an honest error, never a silent "not installed".
  test("real human-format listing text (no --json) -> error, not a silent missing", async () => {
    const reqs: PackRequirements[] = [{ pack: "acme", integrations: [], tools: [] }];
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "plugin" && argv[2] === "list" ? ok(REAL_PLUGIN_LIST_TXT) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "pack.acme");
    expect(r.status).toBe("error");
  });

  test("a malformed pack's requirements.jsonc error surfaces as an error row, not silently dropped (R-T8-L1b)", async () => {
    const reqs: PackRequirements[] = [{ pack: "broken-pack", integrations: [], tools: [], error: "invalid JSON: Unexpected end of input" }];
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "plugin" && argv[2] === "list" ? ok(REAL_PLUGIN_LIST_JSON) : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "pack.broken-pack");
    expect(r.status).toBe("error");
    expect(r.detail).toBe("invalid JSON: Unexpected end of input");
  });

  test("one row per requirement entry", async () => {
    const reqs: PackRequirements[] = [
      { pack: "acme", integrations: [], tools: [] },
      { pack: "other-pack", integrations: [], tools: [] },
    ];
    const exec: ExecScript = (argv) => (argv[0] === "claude" && argv[1] === "plugin" ? ok(REAL_PLUGIN_LIST_JSON) : ok());
    const rows = await toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS);
    expect(rows.filter((row) => row.id.startsWith("pack."))).toHaveLength(2);
  });

  // tool.plugins reads `claude plugin list` unconditionally, so this exec
  // runs even with zero pack requirements.
  test("no pack requirements at all -> claude plugin list still runs once, for tool.plugins", async () => {
    const p = fakeProbes({});
    await toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS);
    expect(p.calls.exec.filter((argv) => argv[0] === "claude" && argv[1] === "plugin" && argv[2] === "list")).toHaveLength(1);
  });
});

describe("Done-screen contract: optional rows with a manual action", () => {
  /**
   * rt-tray's readiness model (Swift, a different suite) lists a row on
   * mattstack.app's Done screen as a step the user still owes exactly when
   * it is optional, not ready, not skipped, its action is steps or
   * open-url, and its optionalNote does not start with "works without"
   * (case-insensitively). These three ids are what this side guarantees
   * are genuine manual steps belonging on that list; every other optional
   * steps/open-url row this module can emit must keep the "works without"
   * wording, since a reworded note here changes what the Done screen shows
   * without failing a single test on either side of the language boundary.
   */
  const DONE_SCREEN_MANUAL_STEP_IDS = new Set(["tool.claude", "tool.fast-browser-extension", "tool.chrome-signin"]);

  function assertOptionalManualActionRows(rows: Row[]) {
    for (const r of rows) {
      if (r.required) continue;
      if (r.action?.type !== "steps" && r.action?.type !== "open-url") continue;
      const worksWithout = (r.optionalNote ?? "").toLowerCase().startsWith("works without");
      expect([r.id, worksWithout || DONE_SCREEN_MANUAL_STEP_IDS.has(r.id)]).toEqual([r.id, true]);
    }
  }

  function fastBrowserSeams(): ToolsSeams {
    return { ...NOOP_SEAMS, resolveTool: (_p, tool) => (tool === "fast-browser" ? { tool, bundled: "node", exec: ["node", "fast-browser.mjs"], userCopy: null, linked: false, chosen: "node" } : noopResolution(tool)) };
  }

  test("claude not signed in, chrome missing (unrequired), and optional team tools missing (steps and open-url): all pass the contract", async () => {
    const reqs: PackRequirements[] = [
      { pack: "somepack", integrations: [], tools: [{ name: "widget", why: "does widget things", optional: true }] },
      { pack: "somepack", integrations: [], tools: [{ name: "sdm", why: "db tunnels", install: { url: "https://x/sdm" }, optional: true }] },
    ];
    const exec: ExecScript = (argv) => {
      if (argv[0] === "claude" && argv[1] === "--version") return ok("1.2.3\n");
      if (argv[0] === "claude" && argv[1] === "auth") return ok(JSON.stringify({ loggedIn: false }));
      if (argv[0] === "widget" || argv[0] === "sdm") return missing(argv[0]!);
      return ok();
    };
    const rows = await toolRows(fakeProbes({ exec }), reqs, { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS);

    // The scenario must actually reach the rows this test exists to guard;
    // otherwise a change that stops emitting one of them would pass here
    // without proving anything.
    const claude = rows.find((r) => r.id === "tool.claude")!;
    expect(claude.required).toBe(false);
    expect(claude.action?.type).toBe("steps");
    const widget = rows.find((r) => r.id === "tool.team.widget")!;
    expect(widget.action?.type).toBe("steps");
    const sdm = rows.find((r) => r.id === "tool.team.sdm")!;
    expect(sdm.action?.type).toBe("open-url");

    assertOptionalManualActionRows(rows);
  });

  test("fast-browser extension not loaded and a pack declaring chrome sign-in: both are the allowlisted manual steps", async () => {
    const reqs: PackRequirements[] = [{ pack: "somepack", integrations: [], tools: [], chrome: { required: true, signedIntoApp: "work@example.com" } }];
    const exec: ExecScript = (argv) => (argv[2] === "doctor" && argv[3] === "--json" ? ok(JSON.stringify(withCheckStatus(REAL_DOCTOR, "extension-loaded", "fail"))) : ok());
    const p = fakeProbes({ exec });
    p.mkdirp("/Applications/Google Chrome.app");
    const rows = await toolRows(p, reqs, { hasBrew: true, secrets: NO_SECRETS }, fastBrowserSeams());

    const extension = rows.find((r) => r.id === "tool.fast-browser-extension")!;
    expect(extension.action?.type).toBe("steps");
    const signin = rows.find((r) => r.id === "tool.chrome-signin")!;
    expect(signin.action?.type).toBe("steps");

    assertOptionalManualActionRows(rows);
  });

  // Proves assertOptionalManualActionRows can actually fail: an unallowlisted
  // id with a reworded note (missing the "works without" prefix) must be
  // caught, not silently pass.
  test("the guard itself rejects a row that isn't allowlisted and isn't 'works without'-worded", () => {
    const drifted: Row = {
      id: "tool.not-allowlisted",
      kind: "tool",
      title: "Drifted",
      why: "why",
      required: false,
      optionalNote: "Optional: rt works fine without this",
      status: "needs-you",
      detail: "detail",
      action: { type: "steps", label: "Show steps…", steps: ["do a thing"] },
      recheck: "on-change",
    };
    expect(() => assertOptionalManualActionRows([drifted])).toThrow();
  });
});

describe("toolRows: tool.linear-mcp", () => {
  const HOME = "/h";
  const hosted = { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer k" } };
  const conf = (config: unknown) => ({ [`${HOME}/.claude.json`]: JSON.stringify(config) });
  const rowFor = (files: Record<string, string>, secrets: SecretPresence) =>
    pickRow(toolRows(fakeProbes({ home: HOME, env: {}, files }), [], { hasBrew: true, secrets }, NOOP_SEAMS), "tool.linear-mcp");

  test("a Linear MCP named linear -> ready", async () => {
    const r = await rowFor(conf({ mcpServers: { linear: hosted } }), HAS_KEY);
    expect([r.status, r.required]).toEqual(["ready", false]);
  });

  test("an OAuth hosted entry with no auth header is still ready", async () => {
    const r = await rowFor(conf({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } }), NO_SECRETS);
    expect(r.status).toBe("ready");
  });

  test("the name linear held by an unrelated server -> needs-you, and says so", async () => {
    const r = await rowFor(conf({ mcpServers: { linear: { type: "http", url: "https://mcp.railway.app/mcp" } } }), HAS_KEY);
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("not a Linear MCP");
  });

  test("a Linear MCP under another name -> missing, naming it", async () => {
    const r = await rowFor(conf({ mcpServers: { "linear-matt": hosted } }), HAS_KEY);
    expect(r.status).toBe("missing");
    expect(r.detail).toContain("linear-matt");
  });

  test("a Linear MCP under another name with no key -> needs-you, since Install would skip", async () => {
    const r = await rowFor(conf({ mcpServers: { "linear-matt": hosted } }), NO_SECRETS);
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("linear-matt");
    expect(r.detail).toContain("connect Linear so Install can add linear");
    expect(r.action?.type).toBe("connect");
  });

  test("nothing configured and no key -> needs-you with a connect action", async () => {
    const r = await rowFor(conf({}), NO_SECRETS);
    expect(r.status).toBe("needs-you");
    expect(r.action).toEqual({ type: "connect", label: "Connect Linear", integration: "linear", fields: [{ name: "apiKey", label: "Linear API key", secret: true, hint: "lin_api_…" }] });
  });

  test("nothing configured but a key is stored -> missing, Install's job", async () => {
    const r = await rowFor(conf({}), HAS_KEY);
    expect([r.status, r.detail]).toEqual(["missing", "installed by Install (linear.mcp)"]);
  });

  test("an absent config file is not an error", async () => {
    const r = await rowFor({}, HAS_KEY);
    expect(r.status).toBe("missing");
  });

  test("an unparsable config -> error naming the file", async () => {
    const r = await rowFor({ [`${HOME}/.claude.json`]: "{ not json" }, HAS_KEY);
    expect(r.status).toBe("error");
    expect(r.detail).toContain(".claude.json");
  });

  test("a config that exists but cannot be read -> error naming the file", async () => {
    const path = `${HOME}/.claude.json`;
    const p = fakeProbes({ home: HOME, env: {}, files: conf({}), unreadable: [path] });
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: HAS_KEY }, NOOP_SEAMS), "tool.linear-mcp");
    expect([r.status, r.required]).toEqual(["error", false]);
    expect(r.detail).toContain(".claude.json");
  });

  test("a secrets seam that throws degrades this row alone, leaving the rest of the group standing", async () => {
    const exploding: SecretPresence = {
      has: async () => {
        throw new Error("keychain locked");
      },
    };
    const rows = await toolRows(fakeProbes({ home: HOME, env: {}, files: conf({}) }), [], { hasBrew: true, secrets: exploding }, NOOP_SEAMS);
    const r = rows.find((row) => row.id === "tool.linear-mcp")!;
    expect([r.status, r.required]).toEqual(["error", false]);
    expect(r.detail).toContain("keychain locked");
    expect(rows.some((row) => row.id === "tool.herdr")).toBe(true);
    expect(rows.some((row) => row.id === "tool.plugins")).toBe(true);
  });

  test("never required, so it can neither block Install nor fail verify", async () => {
    for (const secrets of [NO_SECRETS, HAS_KEY]) {
      const r = await rowFor(conf({}), secrets);
      expect([r.required, r.optionalNote]).toEqual([false, "Installed by Install (linear.mcp)."]);
    }
  });
});

// ─── toolRows: tool.proxy ────────────────────────────────────────────────────
// pinnedPortlessVersion reads deps.lock off REAL disk (bundle-layout.ts's
// readDepsLock, not the Probes seam; same rule steps-b.test.ts documents for
// appBundlePath/bundledToolPath), so a "bundle pins version X" case needs a
// real temp bundle root, not just fakeProbes state.

describe("toolRows: tool.proxy", () => {
  const origHome = process.env.HOME;
  let home: string;
  let appRoot: string;

  beforeEach(() => {
    bundleLayoutTest.resetBundleLayoutMemo();
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-tool-proxy-home-")));
    process.env.HOME = home;
    appRoot = join(realpathSync(mkdtempSync(join(tmpdir(), "rt-tool-proxy-app-"))), "mattstack.app");
    mkdirSync(join(appRoot, "Contents", "Resources"), { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
    bundleLayoutTest.resetBundleLayoutMemo();
  });

  /** Writes a real deps.lock pinning portless at `version` to the real bundle fixture. */
  function writePinnedPortless(version: string): void {
    writeFileSync(
      join(appRoot, "Contents", "Resources", "deps.lock"),
      JSON.stringify({
        schema: 1,
        arch: "arm64",
        tools: [
          {
            name: "portless",
            version,
            license: "MIT",
            url: "https://x/portless.tgz",
            sha256: "a".repeat(64),
            archive: "raw",
            extract: "",
            bundlePath: "Contents/Helpers/portless",
            exec: ["Contents/Helpers/portless"],
            exposeByDefault: true,
            entitlements: "none",
            status: "bundled",
            kind: "helper",
          },
        ],
      }),
    );
  }

  /** Points `mattstack.appPath` at the real fixture bundle and mirrors it into fakeProbes' `dirs` so appBundlePath's own `p.exists(appRoot)` check agrees. */
  function bundledProxyProbes(overrides: Partial<Parameters<typeof fakeProbes>[0]> = {}): ReturnType<typeof fakeProbes> {
    setSetting("mattstack.appPath", appRoot, "machine");
    return fakeProbes({ home, env: { PATH: "" }, ...overrides, dirs: { [appRoot]: [], ...overrides.dirs } });
  }

  test("plist absent -> missing, with the install action", async () => {
    writePinnedPortless("0.15.6");
    const p = bundledProxyProbes();
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.proxy");
    expect(r.status).toBe("missing");
    expect(r.required).toBe(false);
    expect(r.action).toEqual({ type: "run", label: "Install proxy", verb: ["setup", "apply", "--from", "proxy.install"] });
  });

  /** Installed at the pinned version, with the CA portless mints at daemon start. `trusted` drives the `security verify-cert` probe the row runs over it. */
  function installedProxyProbes(trusted: boolean): ReturnType<typeof fakeProbes> {
    return bundledProxyProbes({
      files: {
        [PORTLESS_LAUNCHD_PLIST]: "<plist/>",
        "/Library/Application Support/mattstack/proxy/VERSION": "0.15.6\n",
        [join(home, ".portless", "ca.pem")]: "-----BEGIN CERTIFICATE-----",
      },
      exec: async (argv) => ({ code: argv[0] === "security" && !trusted ? 1 : 0, stdout: "", stderr: "" }),
    });
  }

  test("plist present, VERSION == pinned, CA trusted -> ready", async () => {
    writePinnedPortless("0.15.6");
    const p = installedProxyProbes(true);
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.proxy");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("portless 0.15.6");
    expect(p.calls.exec).toContainEqual(["security", "verify-cert", "-c", join(home, ".portless", "ca.pem"), "-L", "-p", "ssl"]);
  });

  // macOS will not let any process write CA trust without its own dialog, so a
  // user who declined it lands here: the proxy runs, browsers warn, and the row
  // is the only place that says so.
  test("plist present, VERSION == pinned, CA untrusted -> needs-you, with the trust action", async () => {
    writePinnedPortless("0.15.6");
    const r = await pickRow(toolRows(installedProxyProbes(false), [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.proxy");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toBe("Browsers will warn until the proxy certificate is trusted");
    expect(r.action).toEqual({ type: "run", label: "Trust certificate", verb: ["setup", "apply", "--from", "proxy.install"] });
  });

  // No CA at all is the same story for the user (nothing browsers trust), and
  // the same remedy: the helper's trust verb reports what it found.
  test("plist present, VERSION == pinned, no CA on disk -> needs-you", async () => {
    writePinnedPortless("0.15.6");
    const p = bundledProxyProbes({
      files: { [PORTLESS_LAUNCHD_PLIST]: "<plist/>", "/Library/Application Support/mattstack/proxy/VERSION": "0.15.6\n" },
    });
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.proxy");
    expect(r.status).toBe("needs-you");
    expect(p.calls.exec).not.toContainEqual(expect.arrayContaining(["verify-cert"]));
  });

  test("plist present, VERSION != pinned -> needs-you, with the update action re-running proxy.install", async () => {
    writePinnedPortless("0.16.0");
    const p = bundledProxyProbes({
      files: { [PORTLESS_LAUNCHD_PLIST]: "<plist/>", "/Library/Application Support/mattstack/proxy/VERSION": "0.15.6\n" },
    });
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.proxy");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toBe("proxy runs portless 0.15.6, bundle pins 0.16.0");
    expect(r.action).toEqual({ type: "run", label: "Update proxy", verb: ["setup", "apply", "--from", "proxy.install"] });
  });

  test("plist present, VERSION unreadable -> error", async () => {
    writePinnedPortless("0.15.6");
    const versionPath = "/Library/Application Support/mattstack/proxy/VERSION";
    const p = bundledProxyProbes({
      files: { [PORTLESS_LAUNCHD_PLIST]: "<plist/>", [versionPath]: "0.15.6" },
      unreadable: [versionPath],
    });
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.proxy");
    expect(r.status).toBe("error");
    expect(r.detail).toContain(versionPath);
  });

  test("never required, so it can neither block Install nor fail verify", async () => {
    writePinnedPortless("0.15.6");
    const p = bundledProxyProbes();
    const r = await pickRow(toolRows(p, [], { hasBrew: true, secrets: NO_SECRETS }, NOOP_SEAMS), "tool.proxy");
    expect(r.required).toBe(false);
  });
});
