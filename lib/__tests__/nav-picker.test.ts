/**
 * runNavPicker (lib/pick-wrappers.ts, re-exported from lib/navigate.ts):
 * NavPickerOpts translated onto the rt-ui pick verb via runPick, verified
 * against the in-process fake so no real fzf or rt-ui binary is spawned.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { installFakePick, type PickFakeStep } from "../ui/pick-fake.ts";
import { runNavPicker as runNavPickerFromWrappers } from "../pick-wrappers.ts";
import { navSeparator, runNavPicker, type NavOption } from "../navigate.ts";

let fake: ReturnType<typeof installFakePick> | undefined;

afterEach(() => {
  fake?.restore();
  fake = undefined;
});

function resultStep(result: Partial<{ action: string; value: string | null; query: string }>): PickFakeStep {
  return { kind: "result", result: { action: "select", value: null, query: "", ...result } };
}

const OPTIONS: NavOption[] = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
];

test("navigate.ts re-exports the same runNavPicker implemented in pick-wrappers.ts", () => {
  expect(runNavPicker).toBe(runNavPickerFromWrappers);
});

describe("options -> rows", () => {
  test("translates plain options into bold-label rows with no group", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    await runNavPicker({ message: "m", options: OPTIONS });
    const rows = fake.calls[0]!.request.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.value).toBe("a");
    expect(rows[0]!.group).toBeUndefined();
    expect(rows[0]!.left[0]).toMatchObject({ bold: true });
  });

  test("a separator becomes a group boundary: its label names the group for the rows that follow, until the next separator", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "x" })]);
    const options: NavOption[] = [
      { value: "top", label: "Top" },
      navSeparator("Recent"),
      { value: "r1", label: "R1" },
      { value: "r2", label: "R2" },
      navSeparator("Older"),
      { value: "o1", label: "O1" },
    ];
    await runNavPicker({ message: "m", options });
    const rows = fake.calls[0]!.request.rows;
    // Separators are not focusable rows -- 4 real rows in, 4 rows out.
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.value === "top")!.group).toBeUndefined();
    expect(rows.find((r) => r.value === "r1")!.group).toBe("Recent");
    expect(rows.find((r) => r.value === "r2")!.group).toBe("Recent");
    expect(rows.find((r) => r.value === "o1")!.group).toBe("Older");
  });
});

describe("breadcrumb", () => {
  test("defaults to a single bold segment naming the message (nav grammar)", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    await runNavPicker({ message: "Open thing.ts with", options: OPTIONS });
    expect(fake.calls[0]!.request.breadcrumb).toEqual(["Open thing.ts with"]);
  });

  test("an explicit breadcrumb overrides the message-derived default", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    await runNavPicker({ message: "m", options: OPTIONS, breadcrumb: ["rt", "sdm", "connect"] });
    expect(fake.calls[0]!.request.breadcrumb).toEqual(["rt", "sdm", "connect"]);
  });

  test("crumbSuffix rides with an explicit breadcrumb", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    await runNavPicker({ message: "m", options: OPTIONS, breadcrumb: ["rt", "sdm", "connections"], crumbSuffix: "  ● connected" });
    expect(fake.calls[0]!.request.crumbSuffix).toBe("  ● connected");
  });

  test("crumbSuffix is omitted when unset", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    await runNavPicker({ message: "m", options: OPTIONS, breadcrumb: ["rt", "sdm", "connections"] });
    expect(fake.calls[0]!.request.crumbSuffix).toBeUndefined();
  });
});

describe("headerParts -> footer actions", () => {
  test("each headerPart becomes a label-only global action, key and label parsed from 'key: label'", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    await runNavPicker({
      message: "m",
      options: OPTIONS,
      headerParts: ["enter: select", "esc: cancel"],
    });
    const actions = fake.calls[0]!.request.actions ?? [];
    expect(actions).toContainEqual({ id: "enter", label: "select", key: "enter", scope: "global" });
    expect(actions).toContainEqual({ id: "esc", label: "cancel", key: "esc", scope: "global" });
  });

  test("a headerPart whose key matches an expect key or ctrl-up only enriches that action's label, no duplicate", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    await runNavPicker({
      message: "m",
      options: OPTIONS,
      headerParts: ["ctrl-up: back to repo"],
      expectKeys: ["ctrl-x"],
    });
    const actions = fake.calls[0]!.request.actions ?? [];
    const ctrlUpActions = actions.filter((a) => a.key === "ctrl-up");
    expect(ctrlUpActions).toHaveLength(1);
    expect(ctrlUpActions[0]).toEqual({ id: "ctrl-up", label: "back to repo", key: "ctrl-up", scope: "global", event: false });
  });
});

describe("expectKeys -> exit actions", () => {
  test("every expectKey becomes a global action with event:false, and ctrl-up is always included", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    await runNavPicker({
      message: "m",
      options: OPTIONS,
      expectKeys: ["ctrl-x", "alt-enter"],
    });
    const actions = fake.calls[0]!.request.actions ?? [];
    expect(actions).toContainEqual({ id: "ctrl-x", label: "ctrl-x", key: "ctrl-x", scope: "global", event: false });
    expect(actions).toContainEqual({ id: "alt-enter", label: "alt-enter", key: "alt-enter", scope: "global", event: false });
    expect(actions).toContainEqual({ id: "ctrl-up", label: "ctrl-up", key: "ctrl-up", scope: "global", event: false });
  });

  test("pressing a declared expect key ends the picker with that key as result.key, preserving the value and query", async () => {
    fake = installFakePick([resultStep({ action: "ctrl-x", value: "b", query: "be" })]);
    const result = await runNavPicker({ message: "m", options: OPTIONS, expectKeys: ["ctrl-x"] });
    expect(result).toEqual({ value: "b", key: "ctrl-x", query: "be" });
  });
});

describe("result triple (value/key/query)", () => {
  test("a plain select maps to key '' and preserves value/query", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "b", query: "be" })]);
    const result = await runNavPicker({ message: "m", options: OPTIONS });
    expect(result).toEqual({ value: "b", key: "", query: "be" });
  });

  test("cancel maps to null", async () => {
    fake = installFakePick([resultStep({ action: "cancel", value: null, query: "" })]);
    const result = await runNavPicker({ message: "m", options: OPTIONS });
    expect(result).toBeNull();
  });
});

describe("initialQuery / resumeValue / initialPos / exact", () => {
  test("initialQuery passes straight through", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    await runNavPicker({ message: "m", options: OPTIONS, initialQuery: "al" });
    expect(fake.calls[0]!.request.initialQuery).toBe("al");
  });

  test("resumeValue passes straight through", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    await runNavPicker({ message: "m", options: OPTIONS, resumeValue: "b" });
    expect(fake.calls[0]!.request.resumeValue).toBe("b");
  });

  test("initialPos resolves to the value at that 1-based position when resumeValue is unset", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "b" })]);
    await runNavPicker({ message: "m", options: OPTIONS, initialPos: 2 });
    expect(fake.calls[0]!.request.resumeValue).toBe("b");
  });

  test("resumeValue overrides initialPos when both are set", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    await runNavPicker({ message: "m", options: OPTIONS, initialPos: 2, resumeValue: "a" });
    expect(fake.calls[0]!.request.resumeValue).toBe("a");
  });

  test("exact maps to request.exact", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    await runNavPicker({ message: "m", options: OPTIONS, exact: true });
    expect(fake.calls[0]!.request.exact).toBe(true);
  });
});

describe("captureQueryOnNoMatch -> acceptNoMatch", () => {
  test("captureQueryOnNoMatch sets request.acceptNoMatch", async () => {
    fake = installFakePick([resultStep({ action: "select", value: null, query: "zz" })]);
    await runNavPicker({ message: "m", options: OPTIONS, captureQueryOnNoMatch: true });
    expect(fake.calls[0]!.request.acceptNoMatch).toBe(true);
  });

  test("omitted when captureQueryOnNoMatch is not set", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    await runNavPicker({ message: "m", options: OPTIONS });
    expect(fake.calls[0]!.request.acceptNoMatch).toBeUndefined();
  });

  test("a no-match select (value:null) under acceptNoMatch resolves to the captured-query shape", async () => {
    fake = installFakePick([resultStep({ action: "select", value: null, query: "zz" })]);
    const result = await runNavPicker({ message: "m", options: OPTIONS, captureQueryOnNoMatch: true });
    expect(result).toEqual({ value: null, key: "", query: "zz" });
  });
});
