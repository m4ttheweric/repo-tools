# Setup installs (MAT-401) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Install stop deadlocking on a Chrome-having Mac, and make the two pieces it cannot install itself (Fast Browser's Chrome extension, and any baseline Claude plugin that failed to land) visible instead of silent.

**Architecture:** Four changes, no new Install step. `tool.fast-browser` narrows to the binary plus runtime health and only gates on a broken bundle; a new `tool.fast-browser-extension` row owns `extension.loaded` and `pairing.ok` and never gates; a new `tool.plugins` row watches the baseline plugin set and joins `INSTALL_SATISFIED_IDS`; and the Done screen grows a "Still to do" section fed by a new `ReadinessModel` property.

**Tech Stack:** Bun + TypeScript (`lib/setup`, `commands/verify.ts`), Swift/SwiftUI (`rt-tray`), `bun:test`, the rt-tray `Check` harness.

**Spec:** `docs/superpowers/specs/2026-09-03-setup-installs-design.md`

## Global Constraints

- No em dashes or en dashes anywhere, in code, comments, tests or commit messages. Use "..." or rephrase.
- Comments state a constraint the code cannot show. No narration of the next line, no review-facing justification, no ticket numbers in source.
- Register NO new settings key and publish NO rt-client from this branch (rt main's registry is behind published rt-client 0.14.0).
- No new Install step, so `STEP_IDS`, `lib/setup/steps/index.ts` and the step list in `docs/superpowers/specs/2026-08-21-rt-setup-contract.md` stay untouched.
- No new command module, so `lib/module-registry.ts` stays untouched.
- The TypeScript CLI is UI-free: no UI framework, no JSX, no `.tsx` under `commands/`, `lib/`, `scripts/`.
- Never drive, launch or restart Chrome. Nothing in this plan needs a live browser.
- Commit after every task. Never push.

---

### Task 1: Split the Fast Browser rows, read pairing, stop gating on Install's own work

Today `tool.fast-browser` is `required: true` whenever Chrome is installed, but the runtime and extension it checks are created by the `fastbrowser.setup` Install step. On a fresh Mac with Chrome the row is `needs-you`, `canInstall` is false, and nothing the user can do clears it. This task makes the binary the only gating fact and gives the extension its own non-gating row that also checks pairing (`pairing.ok` is declared today and never read, so a loaded-but-unpaired extension reads `ready`).

**Files:**
- Modify: `lib/setup/validators/tools.ts` (the `tool.fast-browser` section, plus `toolRows`)
- Test: `lib/setup/__tests__/validators-tools.test.ts` (the `toolRows — tool.fast-browser` describe block)

**Interfaces:**
- Consumes: `Row`, `Action`, `row()` from `../contract.ts`; `Probes`, `ExecResult` from `../probes.ts`; `ToolsSeams`, `CHROME_PATHS`, `exec()` already in this file.
- Produces: `probeFastBrowser(p: Probes, seams: ToolsSeams): Promise<FastBrowserProbe>`, `fastBrowserRow(probe: FastBrowserProbe): Row`, `fastBrowserExtensionRow(p: Probes, probe: FastBrowserProbe): Row`. Row ids `tool.fast-browser` and `tool.fast-browser-extension`. Task 3 relies on `tool.fast-browser-extension` being `required: false` with a `steps` action.

- [ ] **Step 1: Write the failing tests**

Replace the whole `describe("toolRows — tool.fast-browser", ...)` block in `lib/setup/__tests__/validators-tools.test.ts` with the following. Keep the existing imports and the `fastBrowserSeams` helper shape.

```ts
describe("toolRows — tool.fast-browser", () => {
  test("not resolvable -> missing with the link-bundled action, and this is the one state that gates", async () => {
    const r = await pickRow(toolRows(fakeProbes(), [], { hasBrew: true }, NOOP_SEAMS), "tool.fast-browser");
    expect(r.status).toBe("missing");
    expect(r.required).toBe(true);
    expect(r.action).toEqual({ type: "link-bundled", label: "Use mattstack's", tool: "fast-browser" });
  });

  function fastBrowserSeams(): ToolsSeams {
    return { ...NOOP_SEAMS, resolveTool: (_p, tool) => (tool === "fast-browser" ? { tool, bundled: "node", exec: ["node", "fast-browser.mjs"], userCopy: null, linked: false, chosen: "node" } : noopResolution(tool)) };
  }

  /** doctor's report, with everything unhealthy unless the caller says otherwise. */
  function doctorExec(report: unknown, code = 0): ExecScript {
    return (argv) => (argv[2] === "doctor" && argv[3] === "--json" ? { code, stdout: JSON.stringify(report), stderr: "" } : ok());
  }

  test("runtime ok -> ready, and doctor ran through the resolved exec", async () => {
    const p = fakeProbes({ exec: doctorExec({ runtime: { ok: true } }) });
    const r = await pickRow(toolRows(p, [], { hasBrew: true }, fastBrowserSeams()), "tool.fast-browser");
    expect(p.calls.exec).toContainEqual(["node", "fast-browser.mjs", "doctor", "--json"]);
    expect(r.status).toBe("ready");
  });

  // The runtime is created by the fastbrowser.setup Install step, so before
  // Install it cannot exist and no checklist action can create it. A required
  // row here left canInstall false forever on any Mac with Chrome.
  test("runtime not ready does not gate, even with Chrome installed", async () => {
    const p = fakeProbes({ exec: doctorExec({ runtime: { ok: false } }) });
    p.mkdirp("/Applications/Google Chrome.app");
    const r = await pickRow(toolRows(p, [], { hasBrew: true }, fastBrowserSeams()), "tool.fast-browser");
    expect(r.status).toBe("needs-you");
    expect(r.required).toBe(false);
    expect(r.optionalNote).toBe("Installed by Install (fastbrowser.setup).");
    expect(r.action).toEqual({ type: "run", label: "Run setup", verb: ["tools", "setup", "fast-browser"] });
  });

  test("doctor exits non-zero but prints a parseable healthy report -> ready, not error (M8)", async () => {
    const p = fakeProbes({ exec: doctorExec({ runtime: { ok: true } }, 1) });
    const r = await pickRow(toolRows(p, [], { hasBrew: true }, fastBrowserSeams()), "tool.fast-browser");
    expect(r.status).toBe("ready");
  });

  test("doctor parse failure -> error with the stderr head, and still does not gate", async () => {
    const exec: ExecScript = (argv) => (argv[2] === "doctor" ? { code: 1, stdout: "", stderr: "boom\nmore detail" } : ok());
    const r = await pickRow(toolRows(fakeProbes({ exec }), [], { hasBrew: true }, fastBrowserSeams()), "tool.fast-browser");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("boom");
    expect(r.required).toBe(false);
  });

  test("doctor times out -> error, and still does not gate", async () => {
    const r = await pickRow(toolRows(fakeProbes({ exec: TIMEOUT }), [], { hasBrew: true }, fastBrowserSeams()), "tool.fast-browser");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("timed out");
    expect(r.required).toBe(false);
  });

  test("one doctor run feeds both rows", async () => {
    const p = fakeProbes({ exec: doctorExec({ runtime: { ok: true }, extension: { loaded: true }, pairing: { ok: true } }) });
    p.mkdirp("/Applications/Google Chrome.app");
    const rows = await toolRows(p, [], { hasBrew: true }, fastBrowserSeams());
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
    const p = fakeProbes({ exec: doctorExec({ runtime: { ok: true }, extension: { loaded: false } }) });
    const r = await pickRow(toolRows(p, [], { hasBrew: true }, fastBrowserSeams()), "tool.fast-browser-extension");
    expect(r.status).toBe("skipped");
    expect(r.required).toBe(false);
  });

  test("not loaded -> needs-you with steps that end in pairing", async () => {
    const p = withChrome(doctorExec({ runtime: { ok: true }, extension: { loaded: false } }));
    const r = await pickRow(toolRows(p, [], { hasBrew: true }, fastBrowserSeams()), "tool.fast-browser-extension");
    expect(r.status).toBe("needs-you");
    expect(r.required).toBe(false);
    expect(r.action?.type).toBe("steps");
    const steps = (r.action as { steps: string[] }).steps;
    expect(steps[0]).toContain("chrome://extensions");
    expect(steps.join(" ")).toContain("reconnect token");
  });

  // pairing.ok was declared and never read, so a loaded-but-unpaired
  // extension reported ready while Fast Browser could drive nothing.
  test("loaded but not paired -> needs-you with pairing-only steps", async () => {
    const p = withChrome(doctorExec({ runtime: { ok: true }, extension: { loaded: true }, pairing: { ok: false } }));
    const r = await pickRow(toolRows(p, [], { hasBrew: true }, fastBrowserSeams()), "tool.fast-browser-extension");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("not paired");
    const steps = (r.action as { steps: string[] }).steps;
    expect(steps.join(" ")).not.toContain("chrome://extensions");
    expect(steps.join(" ")).toContain("reconnect token");
  });

  test("loaded and paired -> ready", async () => {
    const p = withChrome(doctorExec({ runtime: { ok: true }, extension: { loaded: true }, pairing: { ok: true } }));
    const r = await pickRow(toolRows(p, [], { hasBrew: true }, fastBrowserSeams()), "tool.fast-browser-extension");
    expect(r.status).toBe("ready");
  });

  // tool.fast-browser already reports an unreadable doctor; two rows for one
  // fact would just double the noise.
  test("doctor unreadable -> skipped, deferring to the Fast Browser row", async () => {
    const p = withChrome(() => ({ code: 1, stdout: "", stderr: "boom" }));
    const r = await pickRow(toolRows(p, [], { hasBrew: true }, fastBrowserSeams()), "tool.fast-browser-extension");
    expect(r.status).toBe("skipped");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/setup/__tests__/validators-tools.test.ts`
Expected: FAIL. The `tool.fast-browser-extension` cases fail with `no row tool.fast-browser-extension`, and the gating cases fail because `required` is still `true`.

- [ ] **Step 3: Implement**

In `lib/setup/validators/tools.ts`, delete the `FAST_BROWSER_EXTENSION_STEPS` constant near the top of the file and replace the entire `// ─── tool.fast-browser ───` section with:

```ts
// ─── tool.fast-browser / tool.fast-browser-extension ───────────────────────

interface FastBrowserDoctor {
  runtime?: { ok?: boolean };
  extension?: { loaded?: boolean };
  pairing?: { ok?: boolean };
}

interface FastBrowserProbe {
  resolvable: boolean;
  doctor: FastBrowserDoctor | null;
  /** Set only when fast-browser resolved but its report could not be read. */
  failure: string | null;
}

/** One `doctor` run feeds both rows: they read different fields of the same report, and a second spawn would double the bounded wait on every plan. */
async function probeFastBrowser(p: Probes, seams: ToolsSeams): Promise<FastBrowserProbe> {
  const resolved = seams.resolveTool(p, "fast-browser");
  if (!resolved.exec) return { resolvable: false, doctor: null, failure: null };

  const res = await exec(p, [...resolved.exec, "doctor", "--json"]);
  if (res.code === 124) return { resolvable: true, doctor: null, failure: "fast-browser doctor timed out" };

  // `doctor` is a health check: it commonly exits non-zero BECAUSE it found a
  // problem, while still printing its JSON report, so a parseable payload is
  // honored regardless of exit code.
  if (res.stdout.trim() !== "") {
    try {
      return { resolvable: true, doctor: JSON.parse(res.stdout) as FastBrowserDoctor, failure: null };
    } catch {
      // An unparseable payload is the failure below, not a silent empty report.
    }
  }
  const head = res.stderr.trim().split("\n")[0] || `exit ${res.code}`;
  return { resolvable: true, doctor: null, failure: `fast-browser doctor failed: ${head}` };
}

const FAST_BROWSER_SETUP_ACTION: Action = { type: "run", label: "Run setup", verb: ["tools", "setup", "fast-browser"] };

/**
 * Everything past the binary is created by the `fastbrowser.setup` Install
 * step, so none of it may gate Install: before Install neither the runtime nor
 * the extension directory exists, and no action on this screen can create
 * them. Same shape as herdrRow above, and the same ruling: binaries gate,
 * follow-ups don't.
 */
const FASTBROWSER_SETUP_NOTE = "Installed by Install (fastbrowser.setup).";

function fastBrowserRow(probe: FastBrowserProbe): Row {
  const base = { id: "tool.fast-browser", kind: "tool" as const, title: "Fast Browser", why: "Backs rt's macro-first browser automation.", required: true, recheck: "on-activate" as const };
  if (!probe.resolvable) return row({ ...base, status: "missing", detail: "fast-browser not found", action: { type: "link-bundled", label: "Use mattstack's", tool: "fast-browser" } });

  const pending = { required: false, optionalNote: FASTBROWSER_SETUP_NOTE };
  if (probe.failure) return row({ ...base, ...pending, status: "error", detail: probe.failure });
  if (probe.doctor?.runtime?.ok === true) return row({ ...base, status: "ready", detail: "runtime ok" });
  return row({ ...base, ...pending, status: "needs-you", detail: "runtime not ready", action: FAST_BROWSER_SETUP_ACTION });
}

const PAIRING_STEPS = [
  "Click the Fast Browser icon in Chrome and copy its reconnect token",
  "Run: fast-browser configure --connection auto, then paste the token into the Keychain prompt",
  "Run: fast-browser doctor",
];
const FAST_BROWSER_LOAD_STEPS: Action = {
  type: "steps",
  label: "Show steps…",
  steps: ["Open chrome://extensions", "Turn on Developer mode", "Load unpacked → ~/.fast-browser/extension/current/unpacked", ...PAIRING_STEPS],
};
const FAST_BROWSER_PAIR_STEPS: Action = { type: "steps", label: "Show steps…", steps: PAIRING_STEPS };

/**
 * Never gates Install in any Chrome state. Loading an unpacked extension is a
 * Chrome step rt cannot perform: fast-browser ships no CRX and has no Web
 * Store listing, and Chrome's unattended paths accept neither an unpacked
 * directory nor a signing key rt holds. The Done screen names it instead.
 */
function fastBrowserExtensionRow(p: Probes, probe: FastBrowserProbe): Row {
  const base = {
    id: "tool.fast-browser-extension",
    kind: "tool" as const,
    title: "Fast Browser extension",
    why: "Fast Browser drives your real Chrome session through this extension.",
    required: false,
    optionalNote: "You load this into Chrome yourself; Install cannot do it for you.",
    recheck: "on-activate" as const,
  };

  if (!CHROME_PATHS(p.home).some((path) => p.exists(path))) return row({ ...base, status: "skipped", detail: "no Google Chrome to load it into" });
  // tool.fast-browser already reports an unreadable doctor; repeating it here
  // would be two rows for one fact.
  if (!probe.doctor) return row({ ...base, status: "skipped", detail: "fast-browser doctor could not be read (see Fast Browser)" });

  if (probe.doctor.extension?.loaded !== true) return row({ ...base, status: "needs-you", detail: "not loaded in Chrome", action: FAST_BROWSER_LOAD_STEPS });
  if (probe.doctor.pairing?.ok !== true) return row({ ...base, status: "needs-you", detail: "loaded but not paired", action: FAST_BROWSER_PAIR_STEPS });
  return row({ ...base, status: "ready", detail: "loaded and paired" });
}
```

Then in `toolRows`, replace the `await fastBrowserRow(p, seams)` entry:

```ts
  const fastBrowser = await probeFastBrowser(p, seams);
  const rows: Row[] = [
    await herdrRow(p, opts),
    await claudeRow(p, opts),
    fastBrowserRow(fastBrowser),
    fastBrowserExtensionRow(p, fastBrowser),
    editorRow(seams),
    chromeRow(p, reqs),
  ];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/setup/__tests__/validators-tools.test.ts`
Expected: PASS, every test in both describe blocks.

- [ ] **Step 5: Run the neighbouring suites and the type check**

Run: `bun test lib/setup && bun x tsc --noEmit`
Expected: PASS. `plan.test.ts` still passes because `resolveTool` against the fake probes finds no fast-browser, so `tool.fast-browser` stays `missing` and `required: true` there.

- [ ] **Step 6: Commit**

```bash
git add lib/setup/validators/tools.ts lib/setup/__tests__/validators-tools.test.ts
git commit -m "setup: split the Fast Browser extension into its own row, read pairing, stop gating Install on fastbrowser.setup's own work"
```

---

### Task 2: A row that watches the baseline Claude plugins

`chat@mattstack` already installs (it is in `BASE_PLUGINS`), but nothing observes the result: only `pack.<pack>` rows read `claude plugin list`, and those cover team packs alone. A baseline plugin that failed to land is invisible to `rt setup status`, `rt verify` and the Done screen.

**Files:**
- Create: `lib/setup/base-plugins.ts`
- Modify: `lib/setup/steps/plugins.ts` (import the constant instead of declaring it)
- Modify: `lib/setup/validators/tools.ts` (new `pluginsRow`, shared matcher, hoisted `claude plugin list`)
- Modify: `lib/setup/plan.ts` (`INSTALL_SATISFIED_IDS`)
- Modify: `commands/verify.ts` (`CI_UNSATISFIABLE_TOOLS`, drop the now-dead fast-browser clause)
- Test: `lib/setup/__tests__/validators-tools.test.ts` (new describe block)
- Test: `lib/setup/__tests__/plan.test.ts` (extend the install-satisfied flip tests)

**Interfaces:**
- Consumes: `INSTALLED_BY_INSTALL_NOTE` (already exported from `validators/tools.ts`), `ExecResult` from `../probes.ts`.
- Produces: `BASE_PLUGINS: string[]` from `lib/setup/base-plugins.ts`; row id `tool.plugins`; `pluginListHasEntry(stdout: string, entry: string): boolean` in `validators/tools.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/setup/__tests__/validators-tools.test.ts`:

```ts
describe("toolRows - tool.plugins", () => {
  const ALL_THREE = "mattstack@mattstack (enabled)\nfast-browser@mattstack (enabled)\nchat@mattstack (enabled)\n";
  function listExec(result: ExecResult): ExecScript {
    return (argv) => (argv[0] === "claude" && argv[1] === "plugin" && argv[2] === "list" ? result : ok());
  }

  test("every baseline plugin present -> ready", async () => {
    const r = await pickRow(toolRows(fakeProbes({ exec: listExec(ok(ALL_THREE)) }), [], { hasBrew: true }, NOOP_SEAMS), "tool.plugins");
    expect(r.status).toBe("ready");
    expect(r.required).toBe(false);
    expect(r.optionalNote).toBe("Installed by Install (plugins.install).");
  });

  test("chat missing -> missing, naming only what is absent", async () => {
    const list = "mattstack@mattstack (enabled)\nfast-browser@mattstack (enabled)\n";
    const r = await pickRow(toolRows(fakeProbes({ exec: listExec(ok(list)) }), [], { hasBrew: true }, NOOP_SEAMS), "tool.plugins");
    expect(r.status).toBe("missing");
    expect(r.detail).toContain("chat@mattstack");
    expect(r.detail).not.toContain("fast-browser@mattstack");
    expect(r.action).toEqual({ type: "run", label: "Install plugins", verb: ["setup", "pack"] });
  });

  // Anchored at the entry's own start, so a marketplace whose name merely
  // contains another entry can never satisfy it.
  test("an entry only mentioned inside another line does not count", async () => {
    const list = "someother@mattstack (enabled) requires chat@mattstack\n";
    const r = await pickRow(toolRows(fakeProbes({ exec: listExec(ok(list)) }), [], { hasBrew: true }, NOOP_SEAMS), "tool.plugins");
    expect(r.status).toBe("missing");
    expect(r.detail).toContain("chat@mattstack");
  });

  test("claude not installed -> skipped", async () => {
    const r = await pickRow(toolRows(fakeProbes({ exec: listExec(missing("claude")) }), [], { hasBrew: true }, NOOP_SEAMS), "tool.plugins");
    expect(r.status).toBe("skipped");
  });

  test("claude plugin list times out -> error", async () => {
    const r = await pickRow(toolRows(fakeProbes({ exec: listExec({ code: 124, stdout: "", stderr: "" }) }), [], { hasBrew: true }, NOOP_SEAMS), "tool.plugins");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("timed out");
  });

  // A crashed or misconfigured CLI is a real failure this row could not see
  // past; "skipped" would read as "nothing to check here", which it is not.
  test("claude plugin list fails for any other reason -> error, not skipped", async () => {
    const r = await pickRow(toolRows(fakeProbes({ exec: listExec({ code: 3, stdout: "", stderr: "boom" }) }), [], { hasBrew: true }, NOOP_SEAMS), "tool.plugins");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("exit 3");
  });

  test("claude plugin list runs once for tool.plugins and the pack rows together", async () => {
    const p = fakeProbes({ exec: listExec(ok(ALL_THREE)) });
    const reqs: PackRequirements[] = [{ pack: "acme", tools: [], integrations: [] }];
    await toolRows(p, reqs, { hasBrew: true }, NOOP_SEAMS);
    expect(p.calls.exec.filter((argv) => argv[1] === "plugin" && argv[2] === "list").length).toBe(1);
  });
});
```

Add `import type { ExecResult } from "../probes.ts";` to the test file's imports if it is not already there.

Append to the `describe("composePlan — install-satisfied flip", ...)` block in `lib/setup/__tests__/plan.test.ts`:

```ts
  test("tool.plugins flips required across plan and status mode", async () => {
    const p = fakeProbes({ exec: readyExec, tray: grantedTray });
    const planned = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "plan", teams: [] });
    const plannedRow = planned.groups.find((g) => g.id === "tools")!.rows.find((r) => r.id === "tool.plugins")!;
    expect(plannedRow.required).toBe(false);
    expect(plannedRow.optionalNote).not.toBeNull();

    const status = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "status", teams: [] });
    const statusRow = status.groups.find((g) => g.id === "tools")!.rows.find((r) => r.id === "tool.plugins")!;
    expect(statusRow.required).toBe(true);
    expect(statusRow.optionalNote).toBeNull();
  });

  // The extension is loaded by hand in Chrome, so it must never reach
  // requiredMissing in either mode: status mode is what the verify Install
  // step runs, and a critical failure there would end every successful
  // install in failure.
  test("tool.fast-browser-extension never counts against canInstall, in either mode", async () => {
    const p = fakeProbes({ exec: readyExec, tray: grantedTray });
    for (const mode of ["plan", "status"] as const) {
      const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode, teams: [] });
      expect(plan.requiredMissing).not.toContain("tool.fast-browser-extension");
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/setup/__tests__/validators-tools.test.ts lib/setup/__tests__/plan.test.ts`
Expected: FAIL with `no row tool.plugins`.

- [ ] **Step 3: Implement**

Create `lib/setup/base-plugins.ts`:

```ts
/**
 * rt's own baseline plugin set. Lives apart from `steps/plugins.ts` so the
 * `tool.plugins` validator can watch exactly what `plugins.install` installs
 * without a validator importing a step (or a second copy of the list drifting
 * from the first).
 */
export const BASE_PLUGINS: string[] = ["mattstack@mattstack", "fast-browser@mattstack", "chat@mattstack"];
```

In `lib/setup/steps/plugins.ts`, delete the local `const BASE_PLUGINS = [...]` line and add `import { BASE_PLUGINS } from "../base-plugins.ts";` alongside the other imports.

In `lib/setup/validators/tools.ts`, add `import { BASE_PLUGINS } from "../base-plugins.ts";` and replace `pluginListHasPack` with the shared matcher:

```ts
/** Anchored at the entry's own start (start of line, optional leading whitespace) so an entry named inside another line can never satisfy it. */
function pluginListHasEntry(stdout: string, entry: string): boolean {
  return stdout.split("\n").some((line) => line.trim().startsWith(entry));
}
```

Update `packRow`'s single call site to `pluginListHasEntry(pluginList.stdout, `${req.pack}@`)`.

Add the row, next to `packRow`:

```ts
/** Exactly the classification packRow uses, so the two rows never disagree about what a `claude plugin list` result means. */
function pluginsRow(pluginList: ExecResult): Row {
  const base = {
    id: "tool.plugins",
    kind: "tool" as const,
    title: "Claude plugins",
    why: "rt's skills, Fast Browser's and rt chat's all reach Claude Code as marketplace plugins.",
    required: false,
    optionalNote: INSTALLED_BY_INSTALL_NOTE,
  };
  if (pluginList.code === 127) return row({ ...base, status: "skipped", detail: "claude not installed" });
  if (pluginList.code === 124) return row({ ...base, status: "error", detail: "claude plugin list timed out" });
  if (pluginList.code !== 0) return row({ ...base, status: "error", detail: `claude plugin list failed (exit ${pluginList.code})` });

  const absent = BASE_PLUGINS.filter((entry) => !pluginListHasEntry(pluginList.stdout, entry));
  if (absent.length === 0) return row({ ...base, status: "ready", detail: `${BASE_PLUGINS.length} plugins installed` });
  return row({ ...base, status: "missing", detail: `not installed: ${absent.join(", ")}`, action: { type: "run", label: "Install plugins", verb: ["setup", "pack"] } });
}
```

At the end of `toolRows`, replace the conditional `claude plugin list` block with one unconditional run shared by both consumers:

```ts
  // One listing feeds tool.plugins and every pack row; tool.plugins is
  // unconditional, so there is no longer a case where nothing needs it.
  const pluginList = await exec(p, ["claude", "plugin", "list"]);
  rows.push(pluginsRow(pluginList));
  for (const req of reqs) rows.push(packRow(req, pluginList));

  return rows;
```

In `lib/setup/plan.ts`, extend the set:

```ts
const INSTALL_SATISFIED_IDS = new Set(["perm.login-items", "tool.daemon", "tool.plugins"]);
```

In `commands/verify.ts`, add `tool.plugins` to the exemption list and drop the clause that is now dead. Replace the `CI_UNSATISFIABLE_TOOLS` doc comment's third bullet and the constant with:

```ts
 * - `tool.plugins` is installed through `claude`, which a runner does not have,
 *   so its absence there is the same designed shape as `tool.claude`'s.
 */
const CI_UNSATISFIABLE_TOOLS = new Set(["tool.claude", "tool.herdr", "tool.plugins"]);
```

and delete these two lines from `ciNeverCritical`:

```ts
  // Bundled, so `missing` still fails — that would mean the bundle is broken.
  if (r.id === "tool.fast-browser" && r.status !== "missing") return true;
```

That clause forgave exactly the states `tool.fast-browser` no longer marks required, and `missing`, the one state that still gates, was never covered by it. Also drop the `tool.fast-browser` bullet from the same doc comment.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/setup commands`
Expected: PASS.

- [ ] **Step 5: Type check**

Run: `bun x tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add lib/setup/base-plugins.ts lib/setup/steps/plugins.ts lib/setup/validators/tools.ts lib/setup/plan.ts commands/verify.ts lib/setup/__tests__/validators-tools.test.ts lib/setup/__tests__/plan.test.ts
git commit -m "setup: add tool.plugins so a baseline plugin that never landed stops being invisible"
```

---

### Task 3: `ReadinessModel` knows which manual steps are still outstanding

The Done screen needs the list, and view code is not reachable from the check harness. The selection belongs in the model, where it is testable.

**Files:**
- Modify: `rt-tray/Sources-core/Readiness/ReadinessModel.swift`
- Test: `rt-tray/Tests/MattstackCoreChecks/ReadinessModelChecks.swift`

**Interfaces:**
- Consumes: `PlanRow`, `RowStatus`, `ActionType` from `MattstackCore`; `allRows` already on the model.
- Produces: `ReadinessModel.outstandingManualRows: [PlanRow]`. Task 4 renders exactly this array.

- [ ] **Step 1: Write the failing test**

In `rt-tray/Tests/MattstackCoreChecks/ReadinessModelChecks.swift`, add a plan builder and a check. Append the builder next to `makePlan`:

```swift
func makeManualPlan(extensionStatus: RowStatus, chromeStatus: RowStatus = .ready) -> Plan {
    let rows = [
        PlanRow(id: "tool.fast-browser", kind: .tool, title: "Fast Browser", why: "w", required: true, status: .ready, recheck: .onActivate),
        PlanRow(id: "tool.fast-browser-extension", kind: .tool, title: "Fast Browser extension", why: "w", required: false,
                optionalNote: "You load this into Chrome yourself; Install cannot do it for you.", status: extensionStatus,
                action: RowAction(type: .steps, label: "Show steps…", steps: ["Open chrome://extensions"]), recheck: .onActivate),
        PlanRow(id: "tool.chrome", kind: .tool, title: "Google Chrome", why: "w", required: false, status: chromeStatus,
                action: RowAction(type: .openURL, label: "Download", url: "https://www.google.com/chrome/"), recheck: .onActivate),
        PlanRow(id: "tool.mission-control", kind: .tool, title: "Mission Control shortcut", why: "w", required: false, status: .needsYou,
                action: RowAction(type: .openSettings, label: "Open Keyboard Settings…", target: "keyboard"), recheck: .onActivate),
    ]
    let missing = rows.filter { $0.required && $0.status != .ready }.map(\.id)
    return Plan(at: "t", team: TeamInfo(slug: "acme", name: "Acme", mode: .join),
                groups: [PlanGroup(id: "tools", title: "Tools", rows: rows)],
                canInstall: missing.isEmpty, requiredMissing: missing)
}
```

Append these checks to the `readinessModelChecks` array:

```swift
    Check("outstandingManualRows lists only optional, not-ready rows whose action a person can act on") { c in
        let m = await MainActor.run { ReadinessModel(plans: FakePlans([makeManualPlan(extensionStatus: .needsYou)]), permissions: FakePermissions(), ticker: FakeTicker()) }
        await m.load()
        await MainActor.run {
            c.expectEqual(m.outstandingManualRows.map(\.id), ["tool.fast-browser-extension"],
                          "steps and open-url qualify; a ready Chrome and an open-settings row do not")
        }
    },
    Check("outstandingManualRows includes a not-ready open-url row and stays in plan order") { c in
        let m = await MainActor.run { ReadinessModel(plans: FakePlans([makeManualPlan(extensionStatus: .needsYou, chromeStatus: .missing)]), permissions: FakePermissions(), ticker: FakeTicker()) }
        await m.load()
        await MainActor.run {
            c.expectEqual(m.outstandingManualRows.map(\.id), ["tool.fast-browser-extension", "tool.chrome"])
        }
    },
    Check("outstandingManualRows is empty when every optional row is ready or skipped") { c in
        let m = await MainActor.run { ReadinessModel(plans: FakePlans([makeManualPlan(extensionStatus: .skipped)]), permissions: FakePermissions(), ticker: FakeTicker()) }
        await m.load()
        await MainActor.run { c.expectEqual(m.outstandingManualRows.count, 0, "a skipped extension is nothing the user owes") }
    },
```

- [ ] **Step 2: Run the checks to verify they fail**

Run: `cd rt-tray && swift test 2>&1 | tail -20`
Expected: FAIL with a compile error, `value of type 'ReadinessModel' has no member 'outstandingManualRows'`.

- [ ] **Step 3: Implement**

In `rt-tray/Sources-core/Readiness/ReadinessModel.swift`, add below `limitedModeAvailable`:

```swift
    /// Steps Install could not take for the user and will not take on a
    /// retry: optional rows still not ready whose action a person performs by
    /// hand. `skipped` is excluded deliberately, since it means the row had
    /// nothing to check rather than something outstanding.
    public var outstandingManualRows: [PlanRow] {
        allRows.filter { row in
            guard !row.required, row.status != .ready, row.status != .skipped else { return false }
            guard let type = row.action?.type else { return false }
            return type == .steps || type == .openURL
        }
    }
```

- [ ] **Step 4: Run the checks to verify they pass**

Run: `cd rt-tray && swift test 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rt-tray/Sources-core/Readiness/ReadinessModel.swift rt-tray/Tests/MattstackCoreChecks/ReadinessModelChecks.swift
git commit -m "readiness: expose the manual steps Install cannot take for you"
```

---

### Task 4: The Done screen names what is still outstanding

`DoneScreen` says "Everything's working" unconditionally, so a machine whose Fast Browser extension is still unloaded is told the opposite of the truth.

**Files:**
- Modify: `rt-tray/Sources/Setup/Screens/DoneScreen.swift`
- Modify: `rt-tray/Sources/Setup/SetupView.swift:25`
- Modify: `rt-tray/Sources/AccessibilityIDs.swift`

**Interfaces:**
- Consumes: `ReadinessModel.outstandingManualRows` from Task 3; `RowView`, `StepsSheet` from `rt-tray/Sources/Setup/Components/`.
- Produces: accessibility ids `setup.done.stillToDo` and `setup.done.stillToDoRow(<rowId>)`.

- [ ] **Step 1: Add the accessibility ids**

In `rt-tray/Sources/AccessibilityIDs.swift`, beside `doneInvite`:

```swift
    static let doneStillToDo = "setup.done.stillToDo"
    static func doneStillToDoRow(_ id: String) -> String { "setup.done.stillToDo.\(id)" }
```

- [ ] **Step 2: Render the section**

Replace `rt-tray/Sources/Setup/Screens/DoneScreen.swift` with:

```swift
import SwiftUI
import MattstackCore

struct DoneScreen: View {
    @ObservedObject var install: InstallRunModel
    @ObservedObject var readiness: ReadinessModel
    let isOwner: Bool
    let onInvite: () -> Void
    @State private var steps: (title: String, steps: [String])?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                Image(systemName: headlineSymbol).font(.system(size: 40)).foregroundStyle(headlineTint)
                VStack(alignment: .leading) {
                    Text(headline).font(.title3.weight(.semibold))
                    Text(verifySummary).foregroundStyle(.secondary)
                }
            }
            Form {
                Section("Where things live") {
                    LabeledContent("Menu bar") { Text("the m at the top right") }
                    LabeledContent("Terminal") { Text("rt — open a new terminal window").font(.system(.body, design: .monospaced)) }
                    LabeledContent("Board") { Link("https://board.mattstack", destination: URL(string: "https://board.mattstack")!) }
                }
                if !readiness.outstandingManualRows.isEmpty {
                    Section("Still to do") {
                        ForEach(readiness.outstandingManualRows) { row in
                            RowView(row: row, isChecking: false, rowID: AXID.doneStillToDoRow(row.id)) { show(row) }
                        }
                    }
                    .accessibilityIdentifier(AXID.doneStillToDo)
                }
            }
            .formStyle(.grouped).scrollDisabled(true)
            HStack {
                Button("Open the board", action: openBoard).accessibilityIdentifier(AXID.doneOpenBoard)
                if isOwner { Button("Invite teammates…", action: onInvite).accessibilityIdentifier(AXID.doneInvite) }
                Spacer()
            }
            Spacer()
        }
        .padding(24)
        .task { await readiness.recheckAll() }
        .sheet(isPresented: Binding(get: { steps != nil }, set: { if !$0 { steps = nil } })) {
            if let steps { StepsSheet(title: steps.title, steps: steps.steps) }
        }
        // .contain: without it, the plain HStack's buttons (Open the board,
        // Invite teammates…) report THIS screen-level identifier instead of
        // their own -- same fix as InstallScreen's stepRow and ChecklistScreen.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AXID.doneScreen)
    }

    private var outstanding: Int { readiness.outstandingManualRows.count }
    private var headline: String { outstanding == 0 ? "Everything's working" : "Installed, with \(outstanding) step\(outstanding == 1 ? "" : "s") left for you" }
    private var headlineSymbol: String { outstanding == 0 ? "checkmark.seal.fill" : "checkmark.seal" }
    private var headlineTint: Color { outstanding == 0 ? .green : .accentColor }

    private func show(_ row: PlanRow) {
        guard let action = row.action else { return }
        if action.type == .openURL, let raw = action.url, let url = URL(string: raw) {
            NSWorkspace.shared.open(url)
            return
        }
        steps = (title: row.title, steps: action.steps ?? [])
    }

    private var verifySummary: String {
        let verify = install.steps.first { $0.id == "verify" }
        let n = install.steps.filter { $0.state == .done }.count
        return verify?.detail.map { "\($0) · \(n) steps done" } ?? "\(n) steps done"
    }

    /// Stub mode never opens a real browser tab -- there's no real board to
    /// show, and a UI test driving this button shouldn't launch one.
    private func openBoard() {
        guard !BundleFlavor.isStubActive else {
            TrayLog.info("open board skipped (stub mode)")
            return
        }
        NSWorkspace.shared.open(URL(string: "https://board.mattstack")!)
    }
}
```

- [ ] **Step 3: Pass the model in**

In `rt-tray/Sources/Setup/SetupView.swift:25`, change the `.done` case to:

```swift
                case .done: DoneScreen(install: install, readiness: readiness, isOwner: team.choice == .create, onInvite: { NotificationCenter.default.post(name: .rtShowSettingsTeam, object: nil) }).transition(pushTransition)
```

- [ ] **Step 4: Build and run the checks**

Run: `cd rt-tray && swift build 2>&1 | tail -20 && swift test 2>&1 | tail -10`
Expected: build succeeds, checks pass. If `RowView`'s `rowID` parameter does not compile in this position, pass it as `RowView(row: row, isChecking: false, rowID: AXID.doneStillToDoRow(row.id), onAction: { show(row) })`.

Do NOT rebuild or re-sign `/Applications/mattstack.app` or `rt-tray/mattstack-dev.app`. `swift build` writes to `.build/` and touches neither.

- [ ] **Step 5: Commit**

```bash
git add rt-tray/Sources/Setup/Screens/DoneScreen.swift rt-tray/Sources/Setup/SetupView.swift rt-tray/Sources/AccessibilityIDs.swift
git commit -m "done screen: name the manual steps Install could not take"
```

---

### Task 5: Whole-branch verification

**Files:** none modified unless a check fails.

- [ ] **Step 1: Run every gate**

```bash
bun run test
bun x tsc --noEmit
bun run docs:check
bun run picker:check
scripts/repo-purity.sh
(cd rt-tray && swift build && swift test)
```

Expected: `bun run test` at or above the 5965-pass baseline with 0 failures; the rest clean. Capture output to a file and grep it rather than scrolling, per the repo's long-output convention.

- [ ] **Step 2: Run the e2e suite for the surfaces this branch changed**

`bun run test` does not run e2e, and CI does. Row ids and `rt verify` output are asserted verbatim there.

```bash
bun run test:e2e 2>&1 | tail -30
```

Expected: PASS. If an e2e test pins the old `tool.fast-browser` steps text or the old row set, update it to the new contract, then re-run.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "setup installs: fix the checks the full gate surfaced"
```
