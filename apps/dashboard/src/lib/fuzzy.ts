/**
 * Small fzf-style fuzzy matcher. fuzzyScore returns null for a non-match, or a
 * score (higher = better) rewarding contiguous runs and word-boundary hits.
 * fuzzyFilter ranks matches, breaking ties toward shorter text.
 */

const BOUNDARY = /[/:\-_. ]/;

export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q === "") return 0;

  let ti = 0;
  let score = 0;
  let firstIdx = -1;
  let prev = -2;

  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return null;
    if (firstIdx === -1) firstIdx = idx;
    if (idx === prev + 1) score += 10;                          // contiguous
    if (idx === 0 || BOUNDARY.test(t[idx - 1]!)) score += 15;   // word boundary
    score += 1;
    prev = idx;
    ti = idx + 1;
  }

  return score - firstIdx; // earlier first match is better
}

export function fuzzyFilter<T>(query: string, items: T[], key: (t: T) => string): T[] {
  if (query.trim() === "") return items;
  return items
    .map((item) => ({ item, text: key(item), score: fuzzyScore(query, key(item)) }))
    .filter((r): r is { item: T; text: string; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length)
    .map((r) => r.item);
}
