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

import { readFileSync } from "fs";
import { homedir, hostname } from "os";
import { join } from "path";

function home(): string {
  return process.env.HOME ?? homedir();
}

/** ~/.mattstack/user/settings.user.jsonc — the user store. */
export function userSettingsPath(): string {
  return join(home(), ".mattstack", "user", "settings.user.jsonc");
}

/** ~/.mattstack/teams/<team>/mattstack/settings.team.jsonc — the team store. */
export function teamSettingsPath(team: string): string {
  return join(teamsDir(), team, "mattstack", "settings.team.jsonc");
}

/**
 * ~/.mattstack/user/local/<machineKey()>/settings.local.jsonc — the machine
 * store (path literals legal here only).
 */
export function machineSettingsPath(): string {
  return join(home(), ".mattstack", "user", "local", machineKey(), "settings.local.jsonc");
}

/** ~/.mattstack/teams — the container every team's local clone lives under. */
export function teamsDir(): string {
  return join(home(), ".mattstack", "teams");
}

/**
 * The stable per-machine key that scopes the machine settings store — so
 * `user/local/<key>/` never collides across machines sharing one synced
 * `user/` tree.
 *
 *  1. `~/.mattstack/machine-key`, trimmed, if present, non-empty, and a SAFE
 *     PATH SEGMENT (no `/` or `\`, not `.` or `..`) — an explicit override
 *     for machines whose hostname isn't stable or unique (fresh installs,
 *     cloned VMs). The value becomes a directory name directly under
 *     `user/local/`, so anything else (a separator, or a segment that would
 *     walk up/stay put) is treated exactly as if the file were absent,
 *     rather than let the override escape that directory.
 *  2. Otherwise the hostname, slugified: lowercased, a trailing `.local`
 *     dropped (mDNS suffix, not part of the identity), every run of
 *     characters outside `[a-z0-9-]` collapsed to one `-`, leading/trailing
 *     `-` trimmed. An all-illegal hostname slugs to `""`, which falls back
 *     to `"default"` rather than producing an empty path segment.
 */
export function machineKey(): string {
  const override = join(home(), ".mattstack", "machine-key");
  try {
    const v = readFileSync(override, "utf8").trim();
    if (v && v !== "." && v !== ".." && !v.includes("/") && !v.includes("\\")) return v;
  } catch {
    // no override file — fall through to the hostname slug
  }
  const slug = hostname()
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "default";
}
