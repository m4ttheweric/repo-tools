import { describe, test, expect } from "bun:test";
import { buildPickerOptions } from "../picker.ts";
import type { DiscoveredConnection } from "../connectors.ts";
import type { RecentEntry } from "../state.ts";

const conn = (id: string, tier?: string): DiscoveredConnection => ({
  id, label: id, sdmResource: `example-${id}`, tier, key: `demo:${id}`, connector: "demo",
});
const recent = (id: string): RecentEntry => ({
  key: `demo:${id}`, label: id, sdmResource: `example-${id}`, lastConnectedAt: "2026-07-01T00:00:00.000Z",
});

describe("buildPickerOptions", () => {
  test("recents first (max 3), then tiers in canonical order", () => {
    const options = buildPickerOptions(
      [conn("p", "production"), conn("s", "staging"), conn("d", "development"), conn("q", "qa")],
      [recent("s"), recent("q"), recent("d"), recent("p")],
    );
    const labels = options.map(o => (o.separator ? `--${o.label}` : o.value));
    expect(labels).toEqual([
      "--Recent", "demo:s", "demo:q", "demo:d",
      "--Development", "demo:d",
      "--QA", "demo:q",
      "--Staging", "demo:s",
      "--Production", "demo:p",
    ]);
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
});
