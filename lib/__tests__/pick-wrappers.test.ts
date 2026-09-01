import { afterEach, describe, expect, test } from "bun:test";
import { installFakePick, type PickFakeStep } from "../ui/pick-fake.ts";
import { BackNavigation, filterableMultiselect, filterableSelect } from "../pick-wrappers.ts";
import type { PickAction } from "../ui/protocol.ts";

let fake: ReturnType<typeof installFakePick> | undefined;

afterEach(() => {
  fake?.restore();
  fake = undefined;
});

function resultStep(result: Partial<{ action: string; value: string | null; values: string[]; query: string }>): PickFakeStep {
  return { kind: "result", result: { action: "select", value: null, query: "", ...result } };
}

describe("filterableSelect", () => {
  test("returns the chosen value", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "b" })]);
    const picked = await filterableSelect({
      message: "Pick one",
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ],
    });
    expect(picked).toBe("b");
  });

  test("returns null on cancel", async () => {
    fake = installFakePick([resultStep({ action: "cancel", value: null })]);
    const picked = await filterableSelect({
      message: "Pick one",
      options: [{ value: "a", label: "Alpha" }],
    });
    expect(picked).toBeNull();
  });

  test("throws BackNavigation when backLabel is set and result.action is back", async () => {
    fake = installFakePick([resultStep({ action: "back", value: null })]);
    await expect(
      filterableSelect({
        message: "Pick one",
        options: [{ value: "a", label: "Alpha" }],
        backLabel: "Switch repo",
      }),
    ).rejects.toBeInstanceOf(BackNavigation);
  });

  test("passes exact through to the request", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    await filterableSelect({
      message: "Pick one",
      options: [{ value: "a", label: "Alpha" }],
      exact: true,
    });
    expect(fake.calls[0]!.request.exact).toBe(true);
  });

  test("translates options into padded bold-label / dim-hint rows", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    await filterableSelect({
      message: "Pick one",
      options: [
        { value: "a", label: "A", hint: "short" },
        { value: "bb", label: "Longer", hint: "hint" },
      ],
    });
    const rows = fake.calls[0]!.request.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.value).toBe("a");
    expect(rows[0]!.left[0]).toEqual({ text: "A".padEnd("Longer".length), bold: true });
    expect(rows[0]!.left[1]).toMatchObject({ tone: "dim" });
    expect(rows[0]!.left[1]!.text).toContain("short");
    expect(rows[0]!.right ?? []).toHaveLength(0);
  });

  test("extras.rows overrides the options translation verbatim", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "x" })]);
    const rows = [{ value: "x", left: [{ text: "custom" }] }];
    await filterableSelect({ message: "Pick one", options: [{ value: "a", label: "Alpha" }] }, { rows });
    expect(fake.calls[0]!.request.rows).toBe(rows);
  });

  test("extras.actions merge into the request and extras.onOpen receives the live handle", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    const extraAction: PickAction = { id: "discard", label: "discard", key: "ctrl-d", scope: "global" };
    let openedHandle: unknown;
    await filterableSelect(
      { message: "Pick one", options: [{ value: "a", label: "Alpha" }] },
      { actions: [extraAction], onOpen: (h) => { openedHandle = h; } },
    );
    expect(fake.calls[0]!.request.actions).toContainEqual(extraAction);
    expect(openedHandle).toBeDefined();
    expect(typeof (openedHandle as any).update).toBe("function");
  });

  test("extras.cap passes through to the request", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    await filterableSelect({ message: "Pick one", options: [{ value: "a", label: "Alpha" }] }, { cap: 50 });
    expect(fake.calls[0]!.request.cap).toBe(50);
  });

  test("backLabel injects a back action wired to ctrl-up", async () => {
    fake = installFakePick([resultStep({ action: "select", value: "a" })]);
    await filterableSelect({
      message: "Pick one",
      options: [{ value: "a", label: "Alpha" }],
      backLabel: "Switch repo",
    });
    expect(fake.calls[0]!.request.actions).toContainEqual({
      id: "back",
      label: "Switch repo",
      key: "ctrl-up",
      scope: "global",
    });
  });
});

describe("filterableMultiselect", () => {
  test("returns the selected values", async () => {
    fake = installFakePick([resultStep({ action: "select", values: ["a", "b"] })]);
    const selected = await filterableMultiselect({
      message: "Pick some",
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ],
    });
    expect(selected).toEqual(["a", "b"]);
  });

  test("returns null on cancel", async () => {
    fake = installFakePick([resultStep({ action: "cancel" })]);
    const selected = await filterableMultiselect({
      message: "Pick some",
      options: [{ value: "a", label: "Alpha" }],
    });
    expect(selected).toBeNull();
  });

  test("forwards initialValues to the request as a preselect and returns result.values", async () => {
    fake = installFakePick([resultStep({ action: "select", values: ["b"] })]);
    const selected = await filterableMultiselect({
      message: "Pick some",
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ],
      initialValues: ["b"],
    });
    expect(fake.calls[0]!.request.initialValues).toEqual(["b"]);
    expect(fake.calls[0]!.request.multi).toBe(true);
    expect(selected).toEqual(["b"]);
  });
});
