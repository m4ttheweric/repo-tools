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
  lastApplyAt?: string;
}

const EMPTY_STATE: SetupState = { v: 1, marketplaces: [], plugins: [], links: [], extensionEditors: [] };

function statePath(home: string): string {
  return join(home, ".mattstack", "rt", "setup-state.json");
}

export function readSetupState(p: Pick<Probes, "readFile" | "home">): SetupState {
  const raw = p.readFile(statePath(p.home));
  if (raw === null) return { ...EMPTY_STATE };
  try {
    return JSON.parse(raw) as SetupState;
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
  };
  const path = statePath(p.home);
  p.mkdirp(dirname(path));
  p.writeFile(path, JSON.stringify(deduped));
  return deduped;
}
