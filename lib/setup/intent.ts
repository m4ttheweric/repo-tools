/**
 * Setup intent — the one in-flight choice (create/join/restore a team) that
 * survives across the dry-run/apply boundary and a resumed `rt setup`.
 * Runtime-only, never committed: ~/.mattstack/rt/setup-intent.json.
 */

import { dirname, join } from "path";
import type { TeamRef } from "./contract.ts";
import type { Probes } from "./probes.ts";

export interface InvitePointer {
  v: 1;
  team: string;
  name: string;
  remote: string;
  owner: string;
  forge: string;
  createdAt: string;
}

export interface SetupIntent {
  v: 1;
  at: string;
  mode: "create" | "join" | "restore";
  team?: { slug: string; name: string; remote: string; others: boolean };
  join?: { id: string; keyB64: string; pointer: InvitePointer };
  restore?: { homeRepo: string };
  /** Orthogonal to `mode` — create and join both need one; restore keeps its own under `restore.homeRepo`. */
  homeRepo?: string;
}

export function intentPath(home: string): string {
  return join(home, ".mattstack", "rt", "setup-intent.json");
}

export function readIntent(p: Pick<Probes, "readFile" | "home">): SetupIntent | null {
  const raw = p.readFile(intentPath(p.home));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as SetupIntent;
  } catch {
    return null;
  }
}

export function writeIntent(p: Pick<Probes, "writeFile" | "mkdirp" | "home">, intent: SetupIntent): void {
  const path = intentPath(p.home);
  p.mkdirp(dirname(path));
  p.writeFile(path, JSON.stringify(intent), 0o600);
}

export function clearIntent(p: Pick<Probes, "removeFile" | "home">): void {
  p.removeFile(intentPath(p.home));
}

/**
 * create/join carry the team identity on the intent itself; restore and the
 * no-intent case fall back to whatever the daemon already discovered on
 * disk. Multi-team fallback takes teams[0] on the assumption the caller
 * passes teams pre-sorted alphabetically — a real picker is a §14 follow-up.
 */
export function teamRefFromIntent(intent: SetupIntent | null, teams: string[]): TeamRef {
  if (intent?.mode === "create" && intent.team) {
    return { slug: intent.team.slug, name: intent.team.name, mode: "create" };
  }
  if (intent?.mode === "join" && intent.join) {
    return { slug: intent.join.pointer.team, name: intent.join.pointer.name, mode: "join" };
  }
  if (intent?.mode === "restore") {
    return { slug: teams[0] ?? "", name: teams[0] ?? "", mode: "restore" };
  }
  return teams.length ? { slug: teams[0]!, name: teams[0]!, mode: "none" } : { slug: "", name: "", mode: "none" };
}
