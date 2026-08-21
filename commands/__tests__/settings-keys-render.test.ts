/**
 * The pure renderers of `rt settings list` (commands/settings-keys.ts).
 *
 * Rendering is where the two "loud degrade" labels live, and they are easy to
 * get wrong in exactly one direction: an UNREGISTERED key has no registry
 * entry, so `migrated` comes back false for it by default — the naive
 * `if (!s.migrated)` branch then tells the user the key "reads legacy",
 * naming a migration window that does not exist for a key rt has never heard
 * of. These tests pin both labels apart.
 */

import { describe, expect, test } from "bun:test";
import { renderListRow } from "../settings-keys.ts";
import type { ListedSetting } from "../../lib/settings/resolve.ts";

/** Strips ANSI so assertions read as plain text. */
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\[[0-9;]*m/g, "");

const row = (over: Partial<ListedSetting>): ListedSetting =>
  ({ key: "rt.roles", value: 1, provenance: [], migrated: true, ...over }) as ListedSetting;

describe("renderListRow", () => {
  test("an unregistered key is labelled ONLY unregistered — never 'reads legacy'", () => {
    const out = plain(renderListRow(row({ key: "rt.fromTheFuture", migrated: false, unregistered: true })));

    expect(out).toContain("(unregistered)");
    expect(out).not.toContain("legacy");
  });

  test("a registered migrated:false key still carries its legacy note", () => {
    // rt.hooks is the deliberately-deferred registered migrated:false key.
    const out = plain(renderListRow(row({ key: "rt.hooks", migrated: false })));

    expect(out).toMatch(/legacy|not writable/);
    expect(out).not.toContain("unregistered");
  });

  test("a plain migrated key renders with no label at all", () => {
    expect(plain(renderListRow(row({ value: { a: 1 } })))).toBe("  rt.roles = {\"a\":1}");
  });
});
