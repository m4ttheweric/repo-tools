export type DriftCause = "frontmatter" | "source" | "fill" | "include" | "structure" | "vendored";

const MARKER_RE = /^<!-- part: (step|slot:\S+|include:\S+) /;

function splitParts(md: string): { key: string; text: string }[] {
  const parts = [{ key: "frontmatter", text: "" }];
  for (const line of md.split("\n")) {
    const marker = MARKER_RE.exec(line);
    if (marker) parts.push({ key: marker[1]!, text: "" });
    parts[parts.length - 1]!.text += `${line}\n`;
  }
  return parts;
}

function causeOf(key: string): DriftCause {
  if (key === "frontmatter") return "frontmatter";
  if (key === "step") return "source";
  return key.startsWith("slot:") ? "fill" : "include";
}

/**
 * Parts are keyed by kind and name only, so a slot rebound to another fill is
 * a fill change rather than a structural one; a changed part list is
 * structural because the parts can no longer be paired.
 *
 * A part runs from its own marker to the next one, flat -- so prose a fill
 * appends after its own inlined `{{include}}` line has no marker of its own
 * and lands inside that include's part, attributing the fill's edit to the
 * include instead.
 */
export function skillMdDriftCauses(onDisk: string, expected: string): DriftCause[] {
  const before = splitParts(onDisk);
  const after = splitParts(expected);
  if (before.length !== after.length || before.some((p, i) => p.key !== after[i]!.key)) return ["structure"];
  const causes: DriftCause[] = [];
  before.forEach((p, i) => {
    if (p.text === after[i]!.text) return;
    const cause = causeOf(p.key);
    if (!causes.includes(cause)) causes.push(cause);
  });
  return causes;
}
