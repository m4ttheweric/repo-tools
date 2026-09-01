/**
 * Layout-smart herdr pane placement. `decidePlacement` is pure (geometry ->
 * where a new pane should go); `openSmartPane` reads an anchor pane's real
 * rect, decides, and performs the herdr call through an injected caller so it
 * works over any transport (socket API or a CLI adapter).
 */

export type Placement =
  | { kind: "split"; direction: "right" | "down" }
  | { kind: "tab" };

export interface PlacementOpts {
  minCols?: number;
  minRows?: number;
}

export interface HerdrCall {
  (method: string, params: Record<string, unknown>): Promise<
    { ok: true; result: any } | { ok: false; code: string; message: string }
  >;
}

// A child below these is not worth splitting into; spill to a new tab instead.
const DEFAULT_MIN_COLS = 50;
const DEFAULT_MIN_ROWS = 14;

/**
 * Where to put a new pane relative to an anchor whose rect (in cells) is given.
 * Cells are ~2:1 (height:width in px), so a pane is visually wider than tall
 * when width > 2*height; split the longer visual axis so both halves stay
 * usable. A null/degenerate rect falls back to a right split (old behavior).
 */
export function decidePlacement(
  rect: { width: number; height: number } | null,
  opts: PlacementOpts = {},
): Placement {
  const minCols = opts.minCols ?? DEFAULT_MIN_COLS;
  const minRows = opts.minRows ?? DEFAULT_MIN_ROWS;
  if (!rect || rect.width <= 0 || rect.height <= 0) return { kind: "split", direction: "right" };
  const canRight = rect.width >= 2 * minCols;
  const canDown = rect.height >= 2 * minRows;
  if (!canRight && !canDown) return { kind: "tab" };
  if (canRight && canDown) {
    return rect.width > 2 * rect.height
      ? { kind: "split", direction: "right" }
      : { kind: "split", direction: "down" };
  }
  return canRight ? { kind: "split", direction: "right" } : { kind: "split", direction: "down" };
}

/** The anchor pane's rect from a herdr `pane.layout`, or null if unavailable. */
async function anchorRect(
  herdr: HerdrCall,
  anchorPaneId: string,
): Promise<{ width: number; height: number } | null> {
  const r = await herdr("pane.layout", { pane_id: anchorPaneId });
  if (!r.ok) return null;
  const pane = (r.result?.layout?.panes ?? []).find((p: any) => p.pane_id === anchorPaneId);
  return pane?.rect ? { width: pane.rect.width, height: pane.rect.height } : null;
}

/**
 * Open a herdr pane placed intelligently next to `anchorPaneId` (split right or
 * down, or a new tab when crowded). Optionally run `command` in it. Returns the
 * new pane id and the placement chosen. Throws on a herdr failure.
 */
export async function openSmartPane(
  herdr: HerdrCall,
  anchorPaneId: string,
  opts: { command?: string; focus?: boolean } & PlacementOpts = {},
): Promise<{ paneId: string; placement: Placement }> {
  const focus = opts.focus ?? true;
  const placement = decidePlacement(await anchorRect(herdr, anchorPaneId), opts);

  let paneId: string | undefined;
  if (placement.kind === "split") {
    const s = await herdr("pane.split", { pane_id: anchorPaneId, direction: placement.direction, focus });
    if (!s.ok) throw new Error(`pane.split failed: ${s.message}`);
    paneId = s.result?.pane?.pane_id;
    if (!paneId) throw new Error("pane.split returned no pane_id");
  } else {
    const workspaceId = anchorPaneId.split(":")[0];
    const t = await herdr("tab.create", { workspace_id: workspaceId, focus });
    if (!t.ok) throw new Error(`tab.create failed: ${t.message}`);
    paneId = t.result?.root_pane?.pane_id;
    if (!paneId) throw new Error("tab.create returned no pane_id");
  }

  if (opts.command) {
    await herdr("pane.send_text", { pane_id: paneId, text: opts.command });
    await herdr("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
  }
  return { paneId, placement };
}
