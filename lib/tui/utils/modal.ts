/**
 * UTILS: Modal state machine helpers
 *
 * Utilities for the modal pattern used in Rezi dashboards:
 * mode union type + app.setMode() + returnToNormal() + app.modes().
 *
 * Source: commands/runner.tsx returnToNormal / app.modes() (lines 686-689, 1933-2080)
 *
 * ─── The Modal Pattern ────────────────────────────────────────────────────────
 *
 * 1. Define a mode union type in your dashboard state:
 *
 *   type Mode =
 *     | { type: "normal" }
 *     | { type: "confirm-delete"; itemId: string }
 *     | { type: "text-input"; purpose: "rename" };
 *
 * 2. Enter a modal (from a key handler):
 *
 *   update((s) => ({ ...s, mode: { type: "confirm-delete", itemId: "abc" } }));
 *   app.setMode("confirm-delete");
 *
 * 3. Exit a modal (from any modal key handler):
 *
 *   returnToNormal(update);
 *   app.setMode("default");
 *
 * 4. Register modal key handlers:
 *
 *   app.modes({
 *     "confirm-delete": {
 *       y: ({ state, update }) => {
 *         const mode = state.mode;
 *         if (mode.type !== "confirm-delete") return;
 *         doDelete(mode.itemId);
 *         returnToNormal(update);
 *         app.setMode("default");
 *       },
 *       n:      ({ update }) => { returnToNormal(update); app.setMode("default"); },
 *       escape: ({ update }) => { returnToNormal(update); app.setMode("default"); },
 *     },
 *     "text-input": {
 *       enter: ({ state, update }) => {
 *         const value = state.inputValue;
 *         doRename(value);
 *         returnToNormal(update);
 *         app.setMode("default");
 *       },
 *       escape: ({ update }) => { returnToNormal(update); app.setMode("default"); },
 *     },
 *   });
 *
 * 5. In your view, render the BottomBar with the current mode:
 *   <BottomBar mode={s.mode} toast={s.toast} hints={hints} />
 */

/** Base interface for all mode types. Every state must have a `mode` field matching this. */
export interface BaseMode {
  type: string;
}

/** The normal (non-modal) mode. */
export interface NormalMode {
  type: "normal";
}

/**
 * Resets the app state back to normal mode and clears any in-flight input value.
 * Call this from any modal key handler (y, n, escape, enter) followed by app.setMode("default").
 *
 * @param update - The Rezi `update` function from a key handler callback.
 * @param extra  - Optional additional state fields to merge alongside the mode reset.
 *
 * @example
 * ```typescript
 * escape: ({ update }) => {
 *   returnToNormal(update);
 *   app.setMode("default");
 * },
 * ```
 */
export function returnToNormal<S extends { mode: BaseMode; inputValue: string }>(
  update: (fn: (s: S) => S) => void,
  extra: Partial<S> = {},
): void {
  update((s) => ({
    ...s,
    mode: { type: "normal" } as BaseMode as S["mode"],
    inputValue: "",
    ...extra,
  }));
}
