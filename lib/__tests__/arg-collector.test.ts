import { afterEach, describe, expect, test } from "bun:test";
import { collectArgs } from "../arg-collector.ts";
import { installFakePick, type PickFakeStep } from "../ui/pick-fake.ts";
import type { CommandArg } from "../command-tree.ts";

let fake: ReturnType<typeof installFakePick> | undefined;

afterEach(() => {
  fake?.restore();
  fake = undefined;
});

function multiResultStep(values: string[]): PickFakeStep {
  return { kind: "result", result: { action: "select", value: null, values, query: "" } };
}

describe("collectArgs", () => {
  test("returns an empty array without picking when there are no arg defs", async () => {
    const collected = await collectArgs("rt worktree provision", []);
    expect(collected).toEqual([]);
  });

  test("multi-selects which args to include via filterableMultiselect, then assembles boolean flags", async () => {
    const argDefs: CommandArg[] = [
      { name: "Force", flag: "--force", type: "boolean" },
      { name: "Dry run", flag: "--dry-run", type: "boolean" },
    ];
    fake = installFakePick([multiResultStep(["Force"])]);

    const collected = await collectArgs("rt worktree dispose", argDefs);

    expect(collected).toEqual(["--force"]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.request.multi).toBe(true);
    expect(fake.calls[0]!.request.message).toBe("rt worktree dispose args");
    expect(fake.calls[0]!.request.rows.map((r) => r.value)).toEqual(["Force", "Dry run"]);
  });

  test("returns null when nothing is selected in the multiselect", async () => {
    const argDefs: CommandArg[] = [{ name: "Force", flag: "--force", type: "boolean" }];
    fake = installFakePick([multiResultStep([])]);

    const collected = await collectArgs("rt worktree dispose", argDefs);

    expect(collected).toBeNull();
  });

  test("returns null when the multiselect is cancelled", async () => {
    const argDefs: CommandArg[] = [{ name: "Force", flag: "--force", type: "boolean" }];
    fake = installFakePick([{ kind: "result", result: { action: "cancel", value: null, query: "" } }]);

    const collected = await collectArgs("rt worktree dispose", argDefs);

    expect(collected).toBeNull();
  });

  test("assembles a positional (flagless) selected arg from a boolean toggle", async () => {
    const argDefs: CommandArg[] = [
      { name: "Verbose", flag: "--verbose", type: "boolean" },
      { name: "Quiet", flag: "--quiet", type: "boolean" },
    ];
    fake = installFakePick([multiResultStep(["Verbose", "Quiet"])]);

    const collected = await collectArgs("rt worktree dispose", argDefs);

    // Declaration order, not selection order.
    expect(collected).toEqual(["--verbose", "--quiet"]);
  });
});
