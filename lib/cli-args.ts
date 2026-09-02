/**
 * Shared argv helpers for command modules that parse raw `args: string[]`
 * themselves (the command tree hands verbs their argv, not pre-parsed
 * flags). Kept minimal — most verbs still hand-roll single-purpose parsing
 * (positional stripping, `--track`/`--caches`-style option values) that
 * doesn't belong here; this only covers what multiple modules duplicated
 * byte-for-byte.
 */

/**
 * Every value passed for a repeatable flag, accepting both `--flag value`
 * and `--flag=value` — the equals form matters for a flag whose fallback on
 * a silent miss is "use the default set instead" rather than "error", where
 * a typo'd `--plist=foo` must not quietly do something else.
 */
export function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  const eqPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === flag && args[i + 1] !== undefined) {
      values.push(args[i + 1]!);
      continue;
    }
    if (a.startsWith(eqPrefix)) values.push(a.slice(eqPrefix.length));
  }
  return values;
}

/** A command module's usage error: caught at the dispatch boundary and turned into a JSON error plus exit 2. */
export class Usage extends Error {}

/**
 * A value flag followed by nothing, or by another flag, is a usage error:
 * silently taking the next flag as the value is how `--mattstack-dirty`
 * once became a sha. Returns undefined only when the flag is absent
 * entirely.
 */
export function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Usage(`${flag} requires a value`);
  return v;
}

export function required(args: string[], flag: string): string {
  const v = flagValue(args, flag);
  if (v === undefined || v === "") throw new Usage(`${flag} is required`);
  return v;
}
