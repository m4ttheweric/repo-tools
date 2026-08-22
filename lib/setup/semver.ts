/**
 * Loose numeric-dotted version compare for tool floors (herdr, team-declared
 * tools, …) — real CLI `--version` output is never a strict semver string
 * (a leading "v", a trailing "-beta"/"+build", or a bare "24" floor with
 * fewer segments than the version it's compared against all show up in
 * practice), so this compares dotted numeric runs positionally with missing
 * trailing segments treated as 0, rather than parsing full semver.
 */

/** Leading "v"/"V" stripped, then the leading run of dot-separated digits — anything after the first non-digit/non-dot character (a "-beta", a "+build", trailing prose) is ignored. */
function parseVersion(v: string): number[] {
  const stripped = v.trim().replace(/^[vV]/, "");
  const match = stripped.match(/^[0-9]+(?:\.[0-9]+)*/);
  const core = match ? match[0] : "0";
  return core.split(".").map((n) => Number.parseInt(n, 10) || 0);
}

/** Missing segments on either side compare as 0, so a floor with fewer segments (e.g. "24") is satisfied by any version sharing that prefix (e.g. "24.19.0"). */
export function atLeast(version: string, floor: string): boolean {
  const v = parseVersion(version);
  const f = parseVersion(floor);
  const len = Math.max(v.length, f.length);
  for (let i = 0; i < len; i++) {
    const a = v[i] ?? 0;
    const b = f[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}
