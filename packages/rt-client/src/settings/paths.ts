/**
 * Settings-store path layout, duplicated from repo-tools/lib/rt-paths.ts:
 * rt-client has no dependency on rt's lib/, so these literals cannot import
 * rtDir()/userSettingsPath()/etc. lib/rt-paths.ts is the authority — change
 * there first, mirror here (same convention as transport.ts's DEFAULT_SOCK
 * and repos.ts's defaultReposJsonPath).
 *
 * HOME is resolved at CALL time via `process.env.HOME ?? homedir()`, matching
 * the original, so tests can repoint the whole tree at a temp dir.
 */

import { homedir } from "os";
import { join } from "path";

function home(): string {
  return process.env.HOME ?? homedir();
}

/** ~/.mattstack/user/settings.jsonc — the user store. */
export function userSettingsPath(): string {
  return join(home(), ".mattstack", "user", "settings.jsonc");
}

/** ~/.mattstack/teams/<team>/mattstack/settings.jsonc — the team store. */
export function teamSettingsPath(team: string): string {
  return join(teamsDir(), team, "mattstack", "settings.jsonc");
}

/** ~/.mattstack/settings.local.jsonc — the machine store (path literals legal here only). */
export function machineSettingsPath(): string {
  return join(home(), ".mattstack", "settings.local.jsonc");
}

/** ~/.mattstack/teams — the container every team's local clone lives under. */
export function teamsDir(): string {
  return join(home(), ".mattstack", "teams");
}
