/**
 * UTILS: computeGroups + clampIdx
 *
 * Pure functions for navigation and list management in any dashboard.
 *
 * Source: commands/runner.tsx computeEntryGroups / clampIdx patterns
 */

// ─── computeGroups ────────────────────────────────────────────────────────────

export interface Group<T> {
  /** The grouping key (e.g. commandTemplate string). */
  key: string;
  /** Display label for the group header (derived from the first item). */
  label: string;
  /** All items in this group, in insertion order. */
  items: T[];
}

/**
 * Groups items by a key function, maintaining insertion order of first occurrence.
 * Items with the same key are placed in the same group.
 *
 * @param items   - The flat array of items to group.
 * @param keyFn   - Returns the grouping key for each item.
 * @param labelFn - Optional. Returns the display label for the group header
 *                  (called with the first item). Defaults to the key itself.
 *
 * @returns Array of groups in the order of first occurrence, each with
 *          { key, label, items }.
 *
 * @example
 * ```typescript
 * const groups = computeGroups(
 *   entries,
 *   (e) => e.commandTemplate,
 *   (firstEntry) => `${firstEntry.packageLabel} · ${firstEntry.script}`,
 * );
 * // groups = [
 * //   { key: "npm run dev",  label: "my-pkg · dev",  items: [...] },
 * //   { key: "npm run test", label: "my-pkg · test", items: [...] },
 * // ]
 * ```
 */
export function computeGroups<T>(
  items: T[],
  keyFn: (item: T) => string,
  labelFn?: (firstItem: T) => string,
): Group<T>[] {
  const groupOrder: string[] = [];
  const groupMap = new Map<string, T[]>();

  for (const item of items) {
    const key = keyFn(item);
    if (!groupMap.has(key)) {
      groupOrder.push(key);
      groupMap.set(key, []);
    }
    groupMap.get(key)!.push(item);
  }

  return groupOrder.map((key) => {
    const groupItems = groupMap.get(key)!;
    const firstItem = groupItems[0]!;
    return {
      key,
      label: labelFn ? labelFn(firstItem) : key,
      items: groupItems,
    };
  });
}

// ─── clampIdx ─────────────────────────────────────────────────────────────────

/**
 * Clamps a navigation index to the valid range [0, items.length - 1].
 * Safe to call even on empty arrays (returns 0).
 *
 * @example
 * ```typescript
 * // Navigate down:
 * update((s) => ({ ...s, idx: clampIdx(s.idx + 1, s.items) }));
 * // Navigate up:
 * update((s) => ({ ...s, idx: clampIdx(s.idx - 1, s.items) }));
 * ```
 */
export function clampIdx(idx: number, items: unknown[]): number {
  if (items.length === 0) return 0;
  return Math.min(Math.max(0, idx), items.length - 1);
}

/**
 * Flattens groups back into a single item array, preserving group order.
 * Useful for mapping a flat cursor index back to a specific item.
 *
 * @example
 * ```typescript
 * const flat = flattenGroups(groups);
 * const focused = flat[s.cursor]; // the item the user has focused
 * ```
 */
export function flattenGroups<T>(groups: Group<T>[]): T[] {
  return groups.flatMap((g) => g.items);
}

/**
 * Given a flat cursor index and the groups it came from,
 * returns which group contains that item.
 */
export function groupForIdx<T>(groups: Group<T>[], idx: number): Group<T> | null {
  let offset = 0;
  for (const group of groups) {
    if (idx < offset + group.items.length) return group;
    offset += group.items.length;
  }
  return null;
}
