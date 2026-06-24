/**
 * Returns the part of `cur` that was appended after the longest common prefix
 * shared with `prev`. If `cur` is shorter than `prev` (truncation or rewrite),
 * returns `cur` in full so callers always get something observable.
 */
export function appendedSuffix(prev: string, cur: string): string {
  let i = 0;
  const limit = Math.min(prev.length, cur.length);
  while (i < limit && prev[i] === cur[i]) i++;
  // If we consumed all of prev, return what follows in cur (the real append).
  // If divergence happened before prev ended, treat the diverged tail as new.
  return cur.slice(i);
}
