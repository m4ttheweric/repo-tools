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
    expect(fake.calls[0]!.request.breadcrumb).toEqual(["rt", "worktree", "dispose"]);
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

  test("prompts a select arg's value through the Go picker (filterableSelect), not fzf", async () => {
    const argDefs: CommandArg[] = [
      {
        name: "Scope",
        flag: "--scope",
        type: "select",
        options: [
          { value: "prod", label: "prod" },
          { value: "dev", label: "dev" },
        ],
      },
    ];
    // One replayed step answers both picks: the arg multiselect reads `values`,
    // the select-value pick reads `value`. The value pick reaching the fake at
    // all is what proves it routes through runPick, not a spawned fzf.
    fake = installFakePick([
      { kind: "result", result: { action: "select", value: "prod", values: ["Scope"], query: "" } },
    ]);

    const collected = await collectArgs("rt settings get", argDefs);

    expect(collected).toEqual(["--scope", "prod"]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.request.multi).toBeFalsy();
    expect(fake.calls[1]!.request.rows.map((r) => r.value)).toEqual(["prod", "dev"]);
    // The select sub-stage's breadcrumb appends the arg being collected as
    // its final segment, distinguishing it from the multiselect stage.
    expect(fake.calls[1]!.request.breadcrumb).toEqual(["rt", "settings", "get", "Scope"]);
    expect(fake.calls[0]!.request.breadcrumb).toEqual(["rt", "settings", "get"]);
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
