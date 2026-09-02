/**
 * rt run's picker presentation: segment-form rows for the queue/preset/
 * last-run states and the footer actions each queue state shows.
 *
 * The pure row builders (__test__) are asserted directly for their segment
 * shape; the full package -> script -> package flow is driven through a
 * sequential rt-ui `pick` fake (lib/ui/pick.ts's __test__.setImpl seam) to
 * prove the wiring, since lib/ui/pick-fake.ts's shared installFakePick
 * replays one script per call and this flow makes several distinct calls.
 * VALUES/flow (queue building, sentinel resolution) are asserted unchanged
 * elsewhere (run-resolve.test.ts, run-preset-launch.test.ts); this file only
 * asserts what the request sent to the picker looks like.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __test__ as pickTest, type PickHandle, type PickImpl } from "../../lib/ui/pick.ts";
import type { PickRequest, PickResult } from "../../lib/ui/protocol.ts";
import { __test__ as runTest, resolveRun, type RunResolution } from "../run.ts";
import { appendRunHistory } from "../../lib/run-history.ts";

// ─── Pure row builders ───────────────────────────────────────────────────────

test("queueRow: mint checkmark, plain package/script text, lavender variation suffix", () => {
  const withVariation = runTest.queueRow(
    { packageRelPath: "apps/adjuster", packagePath: "/r/apps/adjuster", packageLabel: "adjuster", script: "start:dev", command: "x", variationName: "mock-sdm" },
    0,
  );
  expect(withVariation.group).toBe("queue");
  expect(withVariation.left[0]).toEqual({ text: "✓ ", tone: "mint" });
  expect(withVariation.left[1]).toEqual({ text: "adjuster › start:dev" });
  expect(withVariation.left.some((s) => s.tone === "lav" && s.text.includes("mock-sdm"))).toBe(true);

  const noVariation = runTest.queueRow(
    { packageRelPath: ".", packagePath: "/r", packageLabel: "backend", script: "dev", command: "x" },
    1,
  );
  expect(noVariation.left.some((s) => s.tone === "lav")).toBe(false);
  expect(noVariation.value).toBe("__queued:1__");
});

test("launchAllRow and savePresetRow are bold plain rows in the queue group", () => {
  const launch = runTest.launchAllRow(2);
  expect(launch.group).toBe("queue");
  expect(launch.left[0]).toMatchObject({ text: "Launch all", bold: true });
  expect(launch.left.some((s) => s.text.includes("2 queued"))).toBe(true);

  const save = runTest.savePresetRow();
  expect(save.group).toBe("queue");
  expect(save.left[0]).toMatchObject({ text: "Save as preset…", bold: true });
});

test("lastRunRow: mint glyph + age hint, no group (script rows aren't grouped)", () => {
  const row = runTest.lastRunRow({ ts: new Date().toISOString(), cmd: "x", cwd: "/r", worktree: "/r", branch: "b", pkg: "p", script: "dev", exit: 0 });
  expect(row.value).toBe("__rt:last-run__");
  expect(row.group).toBeUndefined();
  expect(row.left[0]).toMatchObject({ text: "↻ dev", tone: "mint" });
  expect(row.left[1]?.text).toContain("last run ·");
  expect(row.left[1]?.tone).toBe("dim");
});

test("plainRow: bold label plus a dim hint, group optional", () => {
  const row = runTest.plainRow({ value: "v", label: "ui", hint: "packages/ui" }, "packages");
  expect(row.group).toBe("packages");
  expect(row.left).toEqual([
    { text: "ui", bold: true },
    { text: "  packages/ui", tone: "dim" },
  ]);
});

test("plainRow: labelWidth pads the label so hints line up down a group", () => {
  const short = runTest.plainRow({ value: "v", label: "ui", hint: "packages/ui" }, "packages", 6);
  expect(short.left[0]).toEqual({ text: "ui    ", bold: true });

  const exact = runTest.plainRow({ value: "v", label: "backend", hint: "apps/backend" }, "packages", 7);
  expect(exact.left[0]).toEqual({ text: "backend", bold: true });

  // Omitted width leaves the label unpadded (a standalone row has nothing to align against).
  const unpadded = runTest.plainRow({ value: "v", label: "ui", hint: "packages/ui" }, "packages");
  expect(unpadded.left[0]).toEqual({ text: "ui", bold: true });
});

test("footerActions: exit keys close with event:false, other header parts are label-only", () => {
  const idle = runTest.footerActions(["enter: select", "ctrl-up: back", "esc: cancel"], [], "run");
  expect(idle).toContainEqual({ id: "ctrl-up", label: "back", key: "ctrl-up", scope: "global", event: false });
  expect(idle.some((a) => a.id === "ctrl-x")).toBe(false);

  const queueActive = runTest.footerActions(["enter: select", "ctrl-x: dequeue", "esc: cancel"], ["ctrl-x"], "queue");
  expect(queueActive).toContainEqual({ id: "ctrl-x", label: "dequeue", key: "ctrl-x", scope: "global", event: false, group: "queue" });
  // ctrl-up is always an exit key even when no header part names it -- label falls back to the key itself.
  expect(queueActive).toContainEqual({ id: "ctrl-up", label: "ctrl-up", key: "ctrl-up", scope: "global", event: false });
});

test("footerActions: primary keys cluster under the lav group label; ctrl-up and esc pin right (F-r1)", () => {
  const actions = runTest.footerActions(["enter: run", "tab: queue", "ctrl-up: back", "esc: quit"], ["tab"], "run");
  const byId = (id: string) => actions.find((a) => a.id === id);
  // enter and tab carry the group label -> lav cluster on the left.
  expect(byId("enter")?.group).toBe("run");
  expect(byId("tab")?.group).toBe("run");
  // ctrl-up (back) and esc (quit) stay ungrouped -> right-pinned run.
  expect(byId("ctrl-up")?.group).toBeUndefined();
  expect(byId("esc")?.group).toBeUndefined();
});

// ─── Wiring: sequential fake over the real package -> script -> package flow ─

/** Deterministic PickImpl that hands back one scripted result per call, in order -- unlike lib/ui/pick-fake.ts's installFakePick, which replays its whole script on every call (fine for the single-call flows it's used for elsewhere, not for this multi-round one). */
function installSequentialPick(results: Array<Omit<PickResult, "t">>): { calls: PickRequest[]; restore: () => void } {
  const calls: PickRequest[] = [];
  let i = 0;
  const impl: PickImpl = (req) => {
    calls.push(req);
    const r = results[i] ?? results[results.length - 1]!;
    i++;
    return {
      update() {},
      modal: async () => null,
      result: Promise.resolve({ t: "result", ...r }),
    } satisfies PickHandle;
  };
  pickTest.setImpl(impl);
  return {
    calls,
    restore() {
      pickTest.setImpl(undefined);
    },
  };
}

let fixtureDir: string | undefined;
let fake: ReturnType<typeof installSequentialPick> | undefined;

afterEach(() => {
  fake?.restore();
  fake = undefined;
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

function makeWorkspaceFixture(): { root: string; pkgAPath: string; pkgBPath: string } {
  const root = mkdtempSync(join(tmpdir(), "rt-run-picker-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
  const pkgA = join(root, "packages", "a");
  const pkgB = join(root, "packages", "b");
  mkdirSync(pkgA, { recursive: true });
  mkdirSync(pkgB, { recursive: true });
  writeFileSync(join(pkgA, "package.json"), JSON.stringify({ name: "a", scripts: { dev: "vite", build: "vite build" } }));
  writeFileSync(join(pkgB, "package.json"), JSON.stringify({ name: "b", scripts: { dev: "vite" } }));
  return { root, pkgAPath: pkgA, pkgBPath: pkgB };
}

test("package picker: queue-active state groups queue rows, adds Launch all + Save as preset, and the footer swaps to ctrl-x", async () => {
  const { root, pkgAPath } = makeWorkspaceFixture();
  fixtureDir = root;
  const repoIdentity = `test-picker-repo-${Date.now()}`;

  // Seeds the ↻ last-run sentinel the first script-picker call (fake.calls[1]) should show.
  appendRunHistory(repoIdentity, {
    ts: new Date().toISOString(),
    cmd: "npm run dev",
    cwd: pkgAPath,
    worktree: root,
    branch: "main",
    pkg: "a",
    script: "dev",
    exit: 0,
  });

  fake = installSequentialPick([
    { action: "select", value: pkgAPath, query: "" }, // 0: package picker, queue empty -- pick package a
    { action: "tab", value: "dev", query: "" }, // 1: script picker (sentinel present) -- queue "dev" via tab
    { action: "select", value: pkgAPath, query: "" }, // 2: package picker, 1 queued -- pick package a again
    { action: "tab", value: "build", query: "" }, // 3: script picker -- queue "build" via tab
    { action: "cancel", value: null, query: "" }, // 4: package picker, 2 queued -- bail out
  ]);

  const ctx = {
    identity: {
      repoName: "picker-fixture",
      identity: repoIdentity,
      repoRoot: root,
      dataDir: "",
      remoteUrl: "",
      baseUrl: "",
    },
  } as never;

  const res: RunResolution = await resolveRun([], ctx);
  expect(res.kind).toBe("cancelled");
  expect(fake.calls).toHaveLength(5);

  // Call 1 (index 1): the script picker for package "a" shows the mint
  // last-run sentinel first, ahead of the plain script rows.
  const scriptCall = fake.calls[1]!;
  expect(scriptCall.rows[0]!.value).toBe("__rt:last-run__");
  expect(scriptCall.rows[0]!.left[0]).toMatchObject({ text: "↻ dev", tone: "mint" });

  // Call 4 (index 4): package picker with 2 items queued (the "queue active" state).
  const queueCall = fake.calls[4]!;
  const queueGroupRows = queueCall.rows.filter((r) => r.group === "queue");
  // 2 queued items + Launch all + Save as preset.
  expect(queueGroupRows).toHaveLength(4);
  expect(queueGroupRows[0]!.left[0]).toEqual({ text: "✓ ", tone: "mint" });
  expect(queueGroupRows[1]!.left[0]).toEqual({ text: "✓ ", tone: "mint" });
  expect(queueGroupRows.some((r) => r.left[0]?.text === "Launch all")).toBe(true);
  expect(queueGroupRows.some((r) => r.left[0]?.text === "Save as preset…")).toBe(true);
  // Presets are hidden once the queue is active; packages stay visible.
  expect(queueCall.rows.some((r) => r.group === "presets")).toBe(false);
  expect(queueCall.rows.filter((r) => r.group === "packages")).toHaveLength(2);
  // Cursor anchors on Launch all once 2+ items are queued.
  expect(queueCall.resumeValue).toBe("__rt:launch-all__");

  // Footer: ctrl-x appears once the queue is active; it's absent on call 0.
  const idleActions = fake.calls[0]!.actions ?? [];
  const queueActions = queueCall.actions ?? [];
  expect(idleActions.some((a) => a.id === "ctrl-x")).toBe(false);
  expect(queueActions).toContainEqual({ id: "ctrl-x", label: "dequeue", key: "ctrl-x", scope: "global", event: false, group: "queue" });
  // The queue-active footer clusters its keys under the "queue" lav label,
  // leaving ctrl-up and esc to pin right (RunChain.dc.html panel 2).
  expect(queueActions.find((a) => a.id === "enter")?.group).toBe("queue");
  expect(queueActions.find((a) => a.id === "ctrl-up")?.group).toBeUndefined();
  // Regression: the queue-active footer used to omit "ctrl-up: back" from its
  // headerParts, so footerActions' generic fallback rendered the key name
  // twice ("ctrl-up ctrl-up") instead of "ctrl-up back".
  expect(queueActions).toContainEqual({ id: "ctrl-up", label: "back", key: "ctrl-up", scope: "global", event: false });
});

test("script picker: a tab-queue advances the cursor to the next script", async () => {
  const { root, pkgAPath } = makeWorkspaceFixture();
  fixtureDir = root;

  fake = installSequentialPick([
    { action: "select", value: pkgAPath, query: "" }, // 0: package picker -- pick a
    { action: "tab", value: "dev", query: "" },        // 1: script picker -- queue "dev"
    { action: "select", value: pkgAPath, query: "" }, // 2: package picker (1 queued) -- pick a again
    { action: "cancel", value: null, query: "" },      // 3: script picker -- capture cursor, then bail
  ]);

  const ctx = {
    identity: { repoName: "picker-fixture", identity: `test-picker-advance-${Date.now()}`, repoRoot: root, dataDir: "", remoteUrl: "", baseUrl: "" },
  } as never;

  const res: RunResolution = await resolveRun([], ctx);
  expect(res.kind).toBe("cancelled");
  expect(fake.calls).toHaveLength(4);
  // Package a's scripts are {dev, build}; after tab-queueing dev the re-opened
  // script picker lands on build, so a repeated tab queues the next script
  // instead of the same one.
  expect(fake.calls[3]!.resumeValue).toBe("build");
});

// ─── esc-abort contract (RunAborted, not a live picker or a launched run) ───

test("esc at the package stage aborts to shell: RunAborted, no further picker call, nothing launched", async () => {
  const { root } = makeWorkspaceFixture();
  fixtureDir = root;

  fake = installSequentialPick([
    { action: "esc", value: null, query: "" }, // package picker: esc
  ]);

  const ctx = {
    identity: {
      repoName: "picker-fixture",
      identity: `test-picker-repo-${Date.now()}`,
      repoRoot: root,
      dataDir: "",
      remoteUrl: "",
      baseUrl: "",
    },
  } as never;

  const res: RunResolution = await resolveRun([], ctx);
  expect(res.kind).toBe("cancelled");
  if (res.kind === "cancelled") expect(res.code).toBe(1);
  // Aborts outright -- doesn't fall through to another picker call.
  expect(fake.calls).toHaveLength(1);
});

test("esc at the script stage aborts to shell, same as the package stage", async () => {
  const { root, pkgAPath } = makeWorkspaceFixture();
  fixtureDir = root;

  fake = installSequentialPick([
    { action: "select", value: pkgAPath, query: "" }, // package picker: pick "a"
    { action: "esc", value: null, query: "" }, // script picker: esc
  ]);

  const ctx = {
    identity: {
      repoName: "picker-fixture",
      identity: `test-picker-repo-${Date.now()}`,
      repoRoot: root,
      dataDir: "",
      remoteUrl: "",
      baseUrl: "",
    },
  } as never;

  const res: RunResolution = await resolveRun([], ctx);
  expect(res.kind).toBe("cancelled");
  if (res.kind === "cancelled") expect(res.code).toBe(1);
  // Aborts outright -- doesn't bounce back to the package picker or run anything.
  expect(fake.calls).toHaveLength(2);
});

// ─── footer wording + breadcrumb ─────────────────────────────────────────────

test("footer reads 'esc quit' everywhere run declares it, not 'esc cancel'", async () => {
  const { readFileSync } = await import("fs");
  const source = readFileSync(new URL("../run.ts", import.meta.url), "utf8");
  expect(source).not.toContain("esc: cancel");
  expect(source).toContain("esc: quit");
});

test("package picker breadcrumb is the bare 'rt run' chevron pair; the repo rides the faint crumbSuffix (RunChain.dc.html panel 1)", async () => {
  const { root, pkgAPath } = makeWorkspaceFixture();
  fixtureDir = root;

  fake = installSequentialPick([
    { action: "select", value: pkgAPath, query: "" }, // package picker
    { action: "cancel", value: null, query: "" }, // script picker -- bail out
  ]);

  const ctx = {
    identity: {
      repoName: "picker-fixture",
      identity: `test-picker-repo-${Date.now()}`,
      repoRoot: root,
      dataDir: "",
      remoteUrl: "",
      baseUrl: "",
    },
  } as never;

  await resolveRun([], ctx);
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[0]!.breadcrumb).toEqual(["rt", "run"]);
  expect(fake.calls[0]!.crumbSuffix).toBe(" · picker-fixture");
});

test("script picker breadcrumb stays 'rt run'; crumbSuffix carries package · path and drops the repo (RunChain.dc.html panel 3)", async () => {
  const { root, pkgAPath } = makeWorkspaceFixture();
  fixtureDir = root;

  fake = installSequentialPick([
    { action: "select", value: pkgAPath, query: "" }, // package picker -- pick "a"
    { action: "cancel", value: null, query: "" }, // script picker -- bail out
  ]);

  const ctx = {
    identity: {
      repoName: "picker-fixture",
      identity: `test-picker-repo-${Date.now()}`,
      repoRoot: root,
      dataDir: "",
      remoteUrl: "",
      baseUrl: "",
    },
  } as never;

  await resolveRun([], ctx);
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1]!.breadcrumb).toEqual(["rt", "run"]);
  expect(fake.calls[1]!.crumbSuffix).toBe(" · a · packages/a");
  expect(fake.calls[1]!.crumbSuffix).not.toContain("picker-fixture");
});

test("regression: a worktree whose basename matches the repo name never doubles the repo segment in crumbSuffix", async () => {
  // The old bug: contextLabel joined repoName and basename(worktreePath) with
  // " / ", so a worktree directory literally named after the repo (the
  // common main-checkout layout) rendered "rt › run › repo / repo". mkdtemp
  // always suffixes a random string, so nest a directory literally named
  // "picker-fixture" to reproduce basename(worktreePath) === repoName exactly.
  // Two packages so the manual package picker actually opens -- the repo
  // segment now only ever reaches the picker through the package stage's
  // crumbSuffix, not the breadcrumb array.
  const parent = mkdtempSync(join(tmpdir(), "run-doubling-"));
  const root = join(parent, "picker-fixture");
  mkdirSync(root);
  fixtureDir = parent;
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
  const pkgA = join(root, "packages", "a");
  const pkgB = join(root, "packages", "b");
  mkdirSync(pkgA, { recursive: true });
  mkdirSync(pkgB, { recursive: true });
  writeFileSync(join(pkgA, "package.json"), JSON.stringify({ name: "a", scripts: { dev: "vite" } }));
  writeFileSync(join(pkgB, "package.json"), JSON.stringify({ name: "b", scripts: { dev: "vite" } }));

  fake = installSequentialPick([{ action: "cancel", value: null, query: "" }]);

  const ctx = {
    identity: {
      repoName: "picker-fixture",
      identity: `test-picker-repo-${Date.now()}`,
      repoRoot: root,
      dataDir: "",
      remoteUrl: "",
      baseUrl: "",
    },
  } as never;

  await resolveRun([], ctx);
  expect(fake.calls).toHaveLength(1);
  const call = fake.calls[0]!;
  expect(call.breadcrumb).toEqual(["rt", "run"]);
  expect(call.crumbSuffix).toBe(" · picker-fixture");
  expect(call.crumbSuffix).not.toContain("picker-fixture / picker-fixture");
});

test("variations picker breadcrumb stays 'rt run'; crumbSuffix reads variation for \"<script>\" (RunChain.dc.html panel 4)", async () => {
  const root = mkdtempSync(join(tmpdir(), "rt-run-var-"));
  fixtureDir = root;
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", scripts: { dev: "vite", build: "vite build" } }));

  fake = installSequentialPick([
    { action: "alt-enter", value: "dev", query: "" }, // script picker -- open variations for "dev"
    { action: "cancel", value: null, query: "" }, // variations picker -- bail out
  ]);

  const ctx = {
    identity: {
      repoName: "picker-fixture",
      identity: `test-picker-repo-${Date.now()}`,
      repoRoot: root,
      dataDir: "",
      remoteUrl: "",
      baseUrl: "",
    },
  } as never;

  const res: RunResolution = await resolveRun([], ctx);
  expect(res.kind).toBe("cancelled");
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1]!.breadcrumb).toEqual(["rt", "run"]);
  expect(fake.calls[1]!.crumbSuffix).toBe(' · variation for "dev"');
});

// ─── package row alignment ───────────────────────────────────────────────────

test("package picker rows: the label column is padded so hints line up (board parity)", async () => {
  const root = mkdtempSync(join(tmpdir(), "rt-run-align-"));
  fixtureDir = root;
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
  const pkgUi = join(root, "packages", "ui");
  const pkgSvc = join(root, "packages", "config-service");
  mkdirSync(pkgUi, { recursive: true });
  mkdirSync(pkgSvc, { recursive: true });
  writeFileSync(join(pkgUi, "package.json"), JSON.stringify({ name: "ui", scripts: { dev: "vite" } }));
  writeFileSync(join(pkgSvc, "package.json"), JSON.stringify({ name: "config-service", scripts: { dev: "vite" } }));

  fake = installSequentialPick([
    { action: "cancel", value: null, query: "" }, // package picker -- just inspect the request
  ]);

  const ctx = {
    identity: {
      repoName: "picker-fixture",
      identity: `test-picker-repo-${Date.now()}`,
      repoRoot: root,
      dataDir: "",
      remoteUrl: "",
      baseUrl: "",
    },
  } as never;

  await resolveRun([], ctx);
  const packageRows = fake.calls[0]!.rows.filter((r) => r.group === "packages");
  expect(packageRows).toHaveLength(2);
  const labelTexts = packageRows.map((r) => r.left[0]!.text as string);
  // Every label in the group pads to the same width -- the hint column starts
  // at the same offset on every row, matching the board.
  const widths = new Set(labelTexts.map((t) => t.length));
  expect(widths.size).toBe(1);
  expect(Math.max(...labelTexts.map((t) => t.length))).toBe("config-service".length);
});

// ─── formatBranchLabel -> formatBranchSegments migration ─────────────────────

test("run.ts no longer calls the deprecated formatBranchLabel; the worktree picker uses formatBranchSegments", async () => {
  const { readFileSync } = await import("fs");
  const source = readFileSync(new URL("../run.ts", import.meta.url), "utf8");
  expect(source).not.toContain("formatBranchLabel(");
  expect(source).toContain("formatBranchSegments(");
});
