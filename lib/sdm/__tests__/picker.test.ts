import { describe, test, expect } from "bun:test";
import { buildPickerOptions } from "../picker.ts";
import type { DiscoveredConnection, UnresolvedGap } from "../connectors.ts";
import type { RecentEntry } from "../state.ts";
import { dim } from "../../ansi.ts";

const conn = (id: string, tier?: string): DiscoveredConnection => ({
  id, label: id, sdmResource: `example-${id}`, tier, key: `demo:${id}`, connector: "demo",
});
const recent = (id: string): RecentEntry => ({
  key: `demo:${id}`, label: id, sdmResource: `example-${id}`, lastConnectedAt: "2026-07-01T00:00:00.000Z",
});
const gap = (overrides: Partial<UnresolvedGap> = {}): UnresolvedGap => ({
  id: "gamma-labs",
  label: "Gamma Labs",
  slug: "gamma",
  env: "labs",
  source: "none",
  candidates: [],
  key: "demo:gamma-labs",
  connector: "demo",
  ...overrides,
});

describe("buildPickerOptions", () => {
  test("recents first, then tiers in canonical order, no duplicate rows", () => {
    const options = buildPickerOptions(
      [conn("p", "production"), conn("s", "staging"), conn("d", "development"), conn("q", "qa")],
      [recent("q")],
    );
    const labels = options.map(o => (o.separator ? `--${o.label}` : o.value));
    // q is promoted to Recent and dropped from the QA group (which then vanishes).
    expect(labels).toEqual([
      "--Recent", "demo:q",
      "--Development", "demo:d",
      "--Staging", "demo:s",
      "--Production", "demo:p",
    ]);
    // Every connection key appears exactly once across the whole list.
    const keys = options.filter(o => !o.separator).map(o => o.value);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("recents cap at 3; a 4th recent still appears once, in its tier", () => {
    const options = buildPickerOptions(
      [conn("a", "qa"), conn("b", "qa"), conn("c", "qa"), conn("d", "qa")],
      [recent("a"), recent("b"), recent("c"), recent("d")],
    );
    const keys = options.filter(o => !o.separator).map(o => o.value);
    expect(keys.filter(k => k === "demo:d")).toHaveLength(1);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("unknown tiers group after known ones, alphabetically", () => {
    const options = buildPickerOptions([conn("z", "sandbox"), conn("a", "staging")], []);
    const seps = options.filter(o => o.separator).map(o => o.label);
    expect(seps).toEqual(["Staging", "sandbox"]);
  });

  test("tierless connections land in an Other group", () => {
    const options = buildPickerOptions([conn("x")], []);
    expect(options[0]!.separator).toBe(true);
    expect(options[0]!.label).toBe("Other");
    expect(options[1]!.value).toBe("demo:x");
    expect(options[1]!.hint).toContain("example-x");
  });

  test("an unresolved gap appends a dimmed 'Needs mapping' group after the tiers", () => {
    const options = buildPickerOptions(
      [conn("d", "development")],
      [],
      [gap({ source: "none", readOnlyAlt: "gamma-labs-read-only" })],
    );
    const tail = options.slice(-2);
    expect(tail[0]!.separator).toBe(true);
    expect(tail[0]!.label).toBe("Needs mapping");
    const gapRow = tail[1]!;
    expect(gapRow.separator).toBeFalsy();
    expect(gapRow.value).toBe("");
    expect(gapRow.label).toBe("Gamma Labs");
    expect(gapRow.color).toBe(dim);
    expect(gapRow.hint).toBe("only read-only gamma-labs-read-only");
  });

  test("no unresolved arg: no 'Needs mapping' group appears (existing behavior unchanged)", () => {
    const options = buildPickerOptions([conn("d", "development")], []);
    expect(options.some(o => o.label === "Needs mapping")).toBe(false);
  });

  test("empty unresolved array: no 'Needs mapping' group appears", () => {
    const options = buildPickerOptions([conn("d", "development")], [], []);
    expect(options.some(o => o.label === "Needs mapping")).toBe(false);
  });

  test("source 'none' without readOnlyAlt hints 'no StrongDM resource'", () => {
    const options = buildPickerOptions([], [], [gap({ source: "none", readOnlyAlt: undefined })]);
    const gapRow = options[options.length - 1]!;
    expect(gapRow.hint).toBe("no StrongDM resource");
  });

  test("source 'ambiguous' hints the candidate list", () => {
    const options = buildPickerOptions(
      [],
      [],
      [gap({ source: "ambiguous", candidates: ["assured-gamma-labs", "assured-gamma-labs-2"] })],
    );
    const gapRow = options[options.length - 1]!;
    expect(gapRow.hint).toBe("candidates: assured-gamma-labs, assured-gamma-labs-2");
  });

  test("multiple gaps each get their own row under one 'Needs mapping' separator", () => {
    const options = buildPickerOptions(
      [],
      [],
      [gap({ id: "a", label: "Gap A", source: "none" }), gap({ id: "b", label: "Gap B", source: "ambiguous", candidates: ["x"] })],
    );
    const seps = options.filter(o => o.separator);
    expect(seps).toHaveLength(1);
    expect(seps[0]!.label).toBe("Needs mapping");
    const rows = options.filter(o => !o.separator);
    expect(rows.map(r => r.label)).toEqual(["Gap A", "Gap B"]);
    expect(rows.every(r => r.value === "")).toBe(true);
  });
});
