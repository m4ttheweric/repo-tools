export type Commit = {
  type: string;
  scope: string | null;
  subject: string;
  description: string;
};

const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/;

export function parseCommit(subject: string): Commit {
  const m = subject.match(CONVENTIONAL);
  if (!m) return { type: "other", scope: null, subject, description: subject };
  return { type: m[1]!, scope: m[2] ?? null, subject, description: m[3]! };
}

// Human labels + display order for the sections we care about; anything else
// falls back to a title-cased scope/type and sorts after these, alphabetically.
const SECTION_ORDER: Array<{ key: string; label: string }> = [
  { key: "daemon", label: "Daemon" },
  { key: "tray", label: "Tray" },
  { key: "sdm", label: "StrongDM" },
  { key: "nav", label: "Navigation" },
  { key: "run", label: "Run" },
  { key: "git", label: "Git" },
  { key: "mr", label: "Merge Requests" },
  { key: "plugin", label: "Plugins" },
  { key: "docs", label: "Documentation" },
  { key: "release", label: "" }, // excluded
];

function titleCase(s: string): string {
  return s.replace(/(^|[-_ ])(\w)/g, (_, sep, c) => (sep ? " " : "") + c.toUpperCase()).trim();
}

const SECTION_KEYS = new Set(SECTION_ORDER.map((s) => s.key));

// Prefer a recognized scope (e.g. "daemon", "tray"); fall back to a
// recognized type (e.g. "docs", "release") when the scope isn't one of our
// known sections; otherwise fall back to whichever is present.
function sectionKey(c: Commit): string {
  const scopeKey = c.scope?.toLowerCase();
  if (scopeKey && SECTION_KEYS.has(scopeKey)) return scopeKey;
  const typeKey = c.type.toLowerCase();
  if (SECTION_KEYS.has(typeKey)) return typeKey;
  return scopeKey ?? typeKey;
}

export function buildReleaseNotes(
  commits: Commit[],
  base: string,
  head: string,
  repoUrl: string,
): string {
  const groups = new Map<string, Commit[]>();
  for (const c of commits) {
    const key = sectionKey(c);
    if (key === "release") continue; // drop chore(release) bookkeeping
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
  }

  const known = new Map(SECTION_ORDER.map((s, i) => [s.key, { ...s, i }]));
  const keys = [...groups.keys()].sort((a, b) => {
    const ka = known.get(a), kb = known.get(b);
    if (ka && kb) return ka.i - kb.i;
    if (ka) return -1;
    if (kb) return 1;
    return a.localeCompare(b);
  });

  const lines: string[] = [];
  for (const key of keys) {
    const label = known.get(key)?.label ?? titleCase(key);
    if (!label) continue;
    lines.push(`### ${label}`, "");
    for (const c of groups.get(key)!) lines.push(`- ${c.description}`);
    lines.push("");
  }
  lines.push(`**Full Changelog**: ${repoUrl.replace(/\/$/, "")}/compare/${base}...${head}`, "");
  return lines.join("\n");
}
