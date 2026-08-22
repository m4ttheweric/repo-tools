/**
 * Setup state — the durable record of what `rt setup apply` has already
 * materialized (marketplaces, plugins, links, extension editors), so a
 * re-run can diff against it instead of redoing idempotent work.
 * ~/.mattstack/rt/setup-state.json.
 */

import { dirname, join } from "path";
import type { Probes } from "./probes.ts";

export interface SetupState {
  v: 1;
  marketplaces: string[];
  plugins: string[];
  links: string[];
  extensionEditors: string[];
  /** Tools linked with `rt deps link --force`: reconcile() must never auto-unlink these just because a user copy showed up on PATH — force is exactly the user overriding that. */
  forcedLinks: string[];
  lastApplyAt?: string;
}

const EMPTY_STATE: SetupState = { v: 1, marketplaces: [], plugins: [], links: [], extensionEditors: [], forcedLinks: [] };

function statePath(home: string): string {
  return join(home, ".mattstack", "rt", "setup-state.json");
}

export function readSetupState(p: Pick<Probes, "readFile" | "home">): SetupState {
  const raw = p.readFile(statePath(p.home));
  if (raw === null) return { ...EMPTY_STATE };
  try {
    // Spread EMPTY_STATE under the parsed value so a state file written before
    // a field existed (e.g. forcedLinks) still backfills that field to [],
    // rather than leaving it undefined for every caller to guard against.
    return { ...EMPTY_STATE, ...(JSON.parse(raw) as Partial<SetupState>) };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function updateSetupState(p: Pick<Probes, "readFile" | "writeFile" | "mkdirp" | "home">, patch: (s: SetupState) => SetupState): SetupState {
  const patched = patch(readSetupState(p));
  const deduped: SetupState = {
    ...patched,
    marketplaces: [...new Set(patched.marketplaces)],
    plugins: [...new Set(patched.plugins)],
    links: [...new Set(patched.links)],
    extensionEditors: [...new Set(patched.extensionEditors)],
    forcedLinks: [...new Set(patched.forcedLinks)],
  };
  const path = statePath(p.home);
  p.mkdirp(dirname(path));
  p.writeFile(path, JSON.stringify(deduped));
  return deduped;
}
