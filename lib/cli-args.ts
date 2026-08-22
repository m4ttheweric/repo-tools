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
