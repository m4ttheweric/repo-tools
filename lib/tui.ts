/**
 * Re-export shim — all ANSI helpers live in lib/ansi.ts.
 * This file is kept for backwards compatibility with existing imports.
 *
 * For new code, import from "../lib/ansi.ts" directly.
 * For Rezi/Ink UI components, import from "../lib/tui/index.ts".
 */
export * from "./ansi.ts";

