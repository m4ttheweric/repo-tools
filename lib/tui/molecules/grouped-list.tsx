/** @jsxImportSource @rezi-ui/jsx */
/**
 * MOLECULE: GroupedList
 *
 * Renders a flat list of items grouped by a key, with:
 *   - Cyan group sub-headers above each group
 *   - ╌╌╌╌ dividers between groups (not before the first)
 *   - A caller-supplied renderItem for each item
 *
 * The cursor (flat index into all items) is threaded through renderItem
 * so each item knows if it's selected.
 *
 * Composed from: GroupHeader + Divider atoms + caller-supplied rows.
 *
 * Usage:
 *   const groups = computeGroups(entries, (e) => e.commandTemplate);
 *   <GroupedList
 *     groups={groups}
 *     cursor={s.entryIdx}
 *     renderItem={(item, globalIdx, isSelected) => (
 *       <EntryRow item={item} isSelected={isSelected} />
 *     )}
 *     emptyMessage="  press [a] to add a process"
 *   />
 *
 * Source: commands/runner.tsx LaneCard entry rendering (lines 1091-1157)
 */

import type { Group } from "../utils/groups.ts";
import { GroupHeader } from "../atoms/section-label.tsx";
import { Divider } from "../atoms/section-label.tsx";
import { C } from "../theme.ts";

export interface GroupedListProps<T> {
  /** Pre-computed groups from computeGroups(). */
  groups: Group<T>[];
  /** Flat cursor index across all items (not the group index). */
  cursor: number;
  /**
   * Renders a single item.
   * @param item       - The item data
   * @param globalIdx  - Its flat index across all groups (for cursor comparison)
   * @param isSelected - Whether this item is currently focused
   */
  renderItem: (item: T, globalIdx: number, isSelected: boolean) => any;
  /** Message shown when groups is empty or all groups have no items. */
  emptyMessage?: string;
}

export function GroupedList<T>({
  groups,
  cursor,
  renderItem,
  emptyMessage = "  no items",
}: GroupedListProps<T>) {
  const hasItems = groups.some((g) => g.items.length > 0);

  if (!hasItems) {
    return <text style={{ fg: C.dim }}>{emptyMessage}</text>;
  }

  const elements: any[] = [];
  let globalIdx = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]!;

    // Divider between groups (not before the first)
    if (gi > 0) {
      elements.push(<Divider key={`sep-${gi}`} />);
    }

    // Group sub-header in cyan
    elements.push(<GroupHeader key={`gh-${gi}`} label={group.label} />);

    // Items in this group
    for (const item of group.items) {
      const isSelected = globalIdx === cursor;
      elements.push(renderItem(item, globalIdx, isSelected));
      globalIdx++;
    }
  }

  return <>{elements}</>;
}
