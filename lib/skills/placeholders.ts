export type Placeholder = { kind: string; arg: string | null; line: number; raw: string };

const PLACEHOLDER_RE = /\{\{([a-z][a-z0-9.-]*)(?::([^}\s]+))?\}\}/g;

export function findPlaceholders(body: string): Placeholder[] {
  const out: Placeholder[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(PLACEHOLDER_RE)) {
      out.push({ kind: m[1]!, arg: m[2] ?? null, line: i + 1, raw: m[0] });
    }
  }
  return out;
}

export function assertNoPlaceholders(body: string, where: string): void {
  const first = findPlaceholders(body)[0];
  if (first) throw new Error(`${where}: unfilled placeholder ${first.raw} at line ${first.line}`);
}
