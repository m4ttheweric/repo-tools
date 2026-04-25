/** @jsxImportSource @rezi-ui/jsx */
/**
 * EntryRow — renders a single lane entry (one service process).
 *
 * Pure props-only view. Closes over nothing beyond imported constants
 * (theme, status maps, spinner frames) and helpers (entryWindowName,
 * entryCommandLabel). Extracted from commands/runner.tsx with no
 * behavior change.
 */

import { entryWindowName, type LaneConfig, type LaneEntry } from "../../runner-store.ts";
import type { RunnerUIState } from "../../../commands/runner.tsx";
import { C, STATUS_COLOR, STATUS_ICON, SPINNER_FRAMES, entryCommandLabel } from "./shared.ts";

export function EntryRow({ lane, entry, ei, isSelectedLane, selectedEi, s, uniform }: {
  lane: LaneConfig; entry: LaneEntry; ei: number;
  isSelectedLane: boolean; selectedEi: number; s: RunnerUIState;
  uniform: boolean;
}) {
  const win = entryWindowName(lane.id, entry.id);
  const state = s.entryStates.get(win) ?? "stopped";
  const isActive = lane.activeEntryId === entry.id;
  const isSelected = isSelectedLane && ei === selectedEi;
  const eKey = `${lane.id}:${entry.id}`;

  const stateColor = STATUS_COLOR[state];
  const enriched = s.enrichment[eKey];
  const branchLeading = enriched?.leading ?? entry.branch ?? "";
  const branchTrailing = enriched?.trailing ?? "";
  const nameColor = isActive ? C.mint : (isSelected ? C.white : C.muted);
  const spinnerChar = SPINNER_FRAMES[s.spinnerFrame % SPINNER_FRAMES.length]!;
  const stateIcon = (state === "starting" || state === "stopping") ? spinnerChar : STATUS_ICON[state];
  const stateLabel =
    state === "starting" ? "starting…" :
    state === "stopping" ? "stopping…" :
    null;

  const rowBg = isSelected ? C.selBg : undefined;

  // Leading holds dirname + title (grows, clips on overflow); trailing holds
  // MR/ticket icons and state tags and is pinned to the right edge by the
  // flex spacer, so they stay visible no matter how long the title is.
  const leadingText = branchLeading || entry.branch || entry.id;

  // The leading text lives inside a `<row flex={1} flexShrink={1}>` wrapper
  // so the row layout gives it the slack between the state icon and trailing
  // metadata AND allows it to shrink below its intrinsic width. The inner
  // `<text textOverflow="ellipsis">` then ellipsizes at the wrapper boundary.
  // `flex` isn't directly on `<text>` in rezi — it's a container-only prop.
  if (uniform) {
    // Compact single-row: only the branch/worktree label differs between entries
    return (
      <row key={eKey} gap={1} style={{ bg: rowBg }}>
        <text style={{ fg: isSelected ? C.pink : C.dim, bg: rowBg }}>{isSelected ? "❯" : " "}</text>
        <text style={{ fg: stateColor, bg: rowBg }}>{stateIcon}</text>
        <row flex={1} flexBasis={0} flexShrink={1}>
          <text textOverflow="ellipsis" style={{ fg: nameColor, bold: isActive, bg: rowBg }}>{leadingText}</text>
        </row>
        {branchTrailing && <text style={{ fg: C.dim, bg: rowBg }}>{branchTrailing}</text>}
        {stateLabel && <text style={{ fg: stateColor, bg: rowBg }}>{stateLabel}</text>}
      </row>
    );
  }

  // Normal two-row layout when commands differ between entries
  const label = entryCommandLabel(entry);
  return (
    <column key={eKey} gap={0}>
      <row key={`${eKey}-1`} gap={1} style={{ bg: rowBg }}>
        <text style={{ fg: isSelected ? C.pink : C.dim, bg: rowBg }}>{isSelected ? "❯" : " "}</text>
        <text style={{ fg: stateColor, bg: rowBg }}>{stateIcon}</text>
        <row flex={1} flexBasis={0} flexShrink={1}>
          <text textOverflow="ellipsis" style={{ fg: nameColor, bold: isActive, bg: rowBg }}>{label}</text>
        </row>
        {stateLabel && <text style={{ fg: stateColor, bg: rowBg }}>{stateLabel}</text>}
      </row>
      <row key={`${eKey}-2`} gap={1} style={{ bg: rowBg }}>
        <text style={{ bg: rowBg }}>{"    "}</text>
        <row flex={1} flexBasis={0} flexShrink={1}>
          <text textOverflow="ellipsis" style={{ fg: C.dim, bg: rowBg }}>{leadingText}</text>
        </row>
        {branchTrailing && <text style={{ fg: C.dim, bg: rowBg }}>{branchTrailing}</text>}
      </row>
    </column>
  );
}
