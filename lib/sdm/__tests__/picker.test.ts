import { describe, test, expect } from "bun:test";
import { buildPickerOptions } from "../picker.ts";
import type { SdmConnection } from "../browse.ts";
import type { RecentEntry } from "../state.ts";

const conn = (id: string, tier?: string): SdmConnection => ({
  label: id, sdmResource: `example-${id}`, tier, key: `demo:${id}`,
});
const recent = (id: string): RecentEntry => ({
  key: `demo:${id}`, label: id, sdmResource: `example-${id}`, lastConnectedAt: "2026-07-01T00:00:00.000Z",
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

  test("a stale-key recent dedups against the catalog by resource, using the current label/key", () => {
    // Old-model recent: different key + stale label, but the SAME sdmResource
    // as a current catalog connection (the real-world dup bug).
    const staleRecent: RecentEntry = {
      key: "old:acme-db-qa", label: "acme-db-qa",
      sdmResource: "example-q", tier: "qa",
      lastConnectedAt: "2026-07-01T00:00:00.000Z",
    };
    const options = buildPickerOptions([conn("q", "qa")], [staleRecent]);
    const rows = options.filter(o => !o.separator);
    // Exactly one row for the resource (no duplicate) ...
    expect(rows).toHaveLength(1);
    // ... and it renders from the CURRENT catalog entry, not the stale recent.
    expect(rows[0]!.value).toBe("demo:q");
    expect(rows[0]!.label).toBe("q");
    expect(options[0]!.label).toBe("Recent");
  });

  test("a recent whose resource left the catalog still shows, with its stored values", () => {
    const goneRecent: RecentEntry = {
      key: "old:gone", label: "Gone DB", sdmResource: "example-gone", tier: "qa",
      lastConnectedAt: "2026-07-01T00:00:00.000Z",
    };
    const options = buildPickerOptions([conn("q", "qa")], [goneRecent]);
    const recentIdx = options.findIndex(o => o.separator && o.label === "Recent");
    expect(options[recentIdx + 1]!.value).toBe("old:gone");
    expect(options[recentIdx + 1]!.label).toBe("Gone DB");
    // The unrelated catalog connection still appears in its tier.
    expect(options.some(o => o.value === "demo:q")).toBe(true);
  });
});
