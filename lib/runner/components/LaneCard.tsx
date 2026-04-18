/** @jsxImportSource @rezi-ui/jsx */
/**
 * LaneCard — renders one lane (proxy status + entry group list).
 *
 * Also exports the pure grouping helpers computeEntryGroups / entryGroupForIdx
 * used by the lane-level dispatch (e.g. the "spread group" confirmation flow
 * in commands/runner.tsx).
 *
 * Pure props-only view. Extracted from commands/runner.tsx with no behavior change.
 */

import { proxyWindowName, type LaneConfig, type LaneEntry } from "../../runner-store.ts";
import type { RunnerUIState } from "../../../commands/runner.tsx";
import { C, entryCommandLabel } from "./shared.ts";
import { EntryRow } from "./EntryRow.tsx";

/** Compute ordered entry groups keyed by exact commandTemplate. */
export function computeEntryGroups(entries: LaneEntry[]): { key: string; label: string; entries: LaneEntry[] }[] {
  const groupOrder: string[] = [];
  const groupMap = new Map<string, LaneEntry[]>();
  for (const entry of entries) {
    const key = entry.commandTemplate;
    if (!groupMap.has(key)) {
      groupOrder.push(key);
      groupMap.set(key, []);
    }
    groupMap.get(key)!.push(entry);
  }
  return groupOrder.map((key) => {
    const groupEntries = groupMap.get(key)!;
    return { key, label: entryCommandLabel(groupEntries[0]!), entries: groupEntries };
  });
}

/** Find which group an entry belongs to (by index into the flat entries array). */
export function entryGroupForIdx(entries: LaneEntry[], idx: number): { key: string; entries: LaneEntry[] } | null {
  const entry = entries[idx];
  if (!entry) return null;
  const key = entry.commandTemplate;
  return { key, entries: entries.filter((e) => e.commandTemplate === key) };
}

export function LaneCard({ lane, li, s }: { lane: LaneConfig; li: number; s: RunnerUIState }) {
  const isSelected = li === s.laneIdx;
  const safeEi = Math.min(s.entryIdx, Math.max(0, lane.entries.length - 1));
  const proxyUp = s.proxyStates[proxyWindowName(lane.id)] ?? false;
  const modeLabel = (lane.mode ?? "warm") === "single" ? "single" : "warm";
  const title = ` LANE ${lane.id}  ·  ${lane.repoName}  ·  :${lane.canonicalPort}  ·  ${modeLabel}  `;

  const groups = computeEntryGroups(lane.entries);

  // Build the entry list with group separators
  const entryElements: any[] = [];
  if (lane.entries.length === 0) {
    entryElements.push(<text key="empty" style={{ fg: C.dim }}>{"  press [a] to add a process"}</text>);
  } else {
    let globalEi = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi]!;
      // Separator between groups (not before the first)
      if (gi > 0) {
        entryElements.push(
          <text key={`sep-${gi}`} style={{ fg: C.dim }}>{"  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌"}</text>
        );
      }
      // Group sub-header
      entryElements.push(
        <text key={`gh-${gi}`} style={{ fg: C.cyan }}>{`  ${group.label}`}</text>
      );
      // Entries in this group — compact/uniform within the group
      for (const entry of group.entries) {
        entryElements.push(
          <EntryRow
            key={`${lane.id}:${entry.id}`}
            lane={lane} entry={entry} ei={globalEi}
            isSelectedLane={isSelected} selectedEi={safeEi} s={s}
            uniform={true}
          />
        );
        globalEi++;
      }
    }
  }

  return (
    <box
      key={lane.id}
      title={title}
      titleAlign="left"
      border={isSelected ? "heavy" : "single"}
      borderStyle={{ fg: isSelected ? C.pink : C.dim }}
      px={1}
      gap={0}
    >
      <row gap={1}>
        <text style={{ fg: proxyUp ? C.mint : C.coral }}>{proxyUp ? "proxy ✓" : "proxy ✗"}</text>
      </row>
      {entryElements}
    </box>
  );
}
