/**
 * Compact↔expanded LaneEntry transform.
 *
 * The on-disk runner config collapses repetitive entries (same package, different
 * worktrees or command variants) into grouped objects. This file owns that
 * bidirectional transform:
 *
 *   compactEntries(LaneEntry[]) → any[]   (write path, disk-shape)
 *   normalizeEntry(any)         → LaneEntry[]   (read path, single raw entry)
 *
 * Round-trip behavior is pinned by [../__tests__/runner-store-compact.test.ts].
 *
 * Runtime-derived fields are never persisted:
 *   - `branch`         populated by the git watcher on first tick
 *   - `ephemeralPort`  allocated by the daemon port allocator on spawn
 *   - `id` (when derivable from worktree basename)
 *
 * Compact shapes:
 *   Single-command:  { commandTemplate, packagePath, ..., worktrees: [{root}] }
 *   Multi-command:   { commandTemplate: [cmd0, cmd1], ..., worktrees: [{root}] }
 *                    (cross-product of cmds × worktrees is expanded on load)
 */

import { basename } from "path";
import type { LaneEntry, Remedy } from "../runner-store.ts";

// ─── Remedy normalization ────────────────────────────────────────────────────

/**
 * Normalize a raw remedy object from disk into the typed shape. Lives here
 * because compact/expand both call it on nested remedy arrays; the public
 * runner-store re-exports it for the global-remedy normalizer.
 */
export function normalizeRemedy(raw: any): Remedy {
  const rawPattern = raw.pattern;
  const pattern: string[] = Array.isArray(rawPattern)
    ? rawPattern.map(String)
    : rawPattern !== undefined ? [String(rawPattern)] : [];
  return {
    name:        String(raw.name ?? ""),
    pattern,
    cmds:        Array.isArray(raw.cmds) ? raw.cmds.map(String) : [],
    thenRestart: raw.thenRestart !== false,
    cooldownMs:  Number(raw.cooldownMs ?? 30_000),
  };
}

// ─── Compact format (read path) ──────────────────────────────────────────────

/**
 * Derive the relative package path from a LaneEntry for use as a compaction key.
 * Returns null if targetDir doesn't start with worktree (safe fallback: no compact).
 */
function relativePackagePath(entry: LaneEntry): string | null {
  if (!entry.worktree || !entry.targetDir.startsWith(entry.worktree)) return null;
  const rel = entry.targetDir.slice(entry.worktree.length).replace(/^\//, "");
  return rel || ".";
}

/**
 * Derive a stable, human-readable entry ID from the worktree root path and
 * command index. The basename of the worktree path is unique within a single
 * repo's worktrees (e.g. "assured-primary", "assured-wktree-2").
 * For the first (or only) command no suffix is added; further variants get a
 * numeric suffix: "assured-primary-1", "assured-primary-2".
 */
function worktreeEntryId(worktreeRoot: string, cmdIdx = 0): string {
  const base = basename(worktreeRoot);
  return cmdIdx === 0 ? base : `${base}-${cmdIdx}`;
}

/**
 * Expand a compact entry (has `worktrees` array) into individual LaneEntry objects.
 * Handles both single-command and multi-command (commandTemplate array) shapes.
 * ephemeralPort is always 0 on load — the daemon allocates it dynamically.
 */
function expandCompactEntry(raw: any): LaneEntry[] {
  if (!Array.isArray(raw.worktrees) || raw.worktrees.length === 0) {
    return [normalizeExpandedEntry(raw)];
  }

  const pm           = String(raw.pm ?? "");
  const script       = String(raw.script ?? "");
  const packagePath  = String(raw.packagePath ?? "");
  const packageLabel = String(raw.packageLabel ?? "");
  const remedies     = Array.isArray(raw.remedies) ? raw.remedies.map(normalizeRemedy) : undefined;

  // Normalise commandTemplate → always string[]
  const rawCmd   = raw.commandTemplate;
  const commands: string[] = Array.isArray(rawCmd)
    ? rawCmd.map(String)
    : [String(rawCmd ?? (pm && script ? `${pm} run ${script}` : ""))];

  const entries: LaneEntry[] = [];

  // Commands outer, worktrees inner — matches computeEntryGroups() render order
  // (all entries for cmd[0] first, then cmd[1], ...) so entryIdx maps correctly.
  for (let i = 0; i < commands.length; i++) {
    for (const wt of raw.worktrees as any[]) {
      const root      = String(wt.root ?? "");
      const targetDir = packagePath && packagePath !== "." ? `${root}/${packagePath}` : root;
      entries.push({
        id:              worktreeEntryId(root, i),
        targetDir,
        pm,
        script,
        packageLabel,
        worktree:        root,
        branch:          "",  // populated at runtime by git watcher
        ephemeralPort:   0,   // allocated at runtime by port allocator
        commandTemplate: commands[i]!,
        ...(remedies ? { remedies } : {}),
      } satisfies LaneEntry);
    }
  }

  return entries;
}

/** Normalise a plain (already-expanded) entry object. */
function normalizeExpandedEntry(raw: any): LaneEntry {
  const pm     = String(raw.pm ?? "");
  const script = String(raw.script ?? "");
  const worktree = String(raw.worktree ?? "");
  // Derive id from worktree basename if not explicitly stored
  const id = String(raw.id || (worktree ? worktreeEntryId(worktree) : ""));
  return {
    id,
    targetDir:       String(raw.targetDir ?? ""),
    pm,
    script,
    packageLabel:    String(raw.packageLabel ?? ""),
    worktree,
    branch:          "",  // populated at runtime
    ephemeralPort:   0,   // allocated at runtime
    commandTemplate: String(raw.commandTemplate ?? (pm && script ? `${pm} run ${script}` : "")),
    remedies:        Array.isArray(raw.remedies) ? raw.remedies.map(normalizeRemedy) : undefined,
  };
}

/** Parse an entry that may be compact or expanded. */
export function normalizeEntry(raw: any): LaneEntry[] {
  return Array.isArray(raw.worktrees) ? expandCompactEntry(raw) : [normalizeExpandedEntry(raw)];
}

// ─── Compaction (write path) ─────────────────────────────────────────────────

/**
 * Grouping key for compaction.
 * Excludes commandTemplate so different command variants of the same
 * package group together into one multi-command compact entry.
 * Excludes ephemeralPort — it is never written to disk.
 */
function compactSig(e: LaneEntry): string | null {
  const rel = relativePackagePath(e);
  if (rel === null) return null;
  return `${e.packageLabel}\x00${e.pm}\x00${e.script}\x00${rel}`;
}

/**
 * Compact a LaneEntry[] back to the concise on-disk format.
 *
 * Groups entries by (packageLabel, pm, script, packagePath). Within each group:
 *   - Collects distinct commandTemplates in order of first appearance.
 *   - Builds a worktrees array; each worktree item uses `ids[]` when there are
 *     multiple command variants, `id` (singular) when there is only one.
 *   - ephemeralPort is never written — always re-allocated at runtime.
 *   - True singletons (1 entry, not groupable) stay as expanded objects.
 */
export function compactEntries(entries: LaneEntry[]): any[] {
  const seen  = new Map<string, LaneEntry[]>();
  const order = new Map<string, number>();
  const solo: { pos: number; entry: LaneEntry }[] = [];

  // Each entry gets a unique absolute position so write-order always mirrors
  // input order. Groups inherit the position of their first member.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const sig = compactSig(e);
    if (sig === null) { solo.push({ pos: i, entry: e }); continue; }
    if (!seen.has(sig)) { seen.set(sig, []); order.set(sig, i); }
    seen.get(sig)!.push(e);
  }

  const slots: { pos: number; value: any }[] = [];

  for (const [sig, group] of seen) {
    const pos   = order.get(sig)!;
    const first = group[0]!;
    const rel   = relativePackagePath(first)!;

    if (group.length === 1) {
      // True singleton — keep as expanded object, strip ephemeralPort
      const { ephemeralPort: _port, ...rest } = first;
      slots.push({ pos, value: rest });
      continue;
    }

    // Collect ordered command variants (insertion order)
    const cmdOrder: string[] = [];
    const cmdSet = new Set<string>();
    for (const e of group) {
      if (!cmdSet.has(e.commandTemplate)) { cmdSet.add(e.commandTemplate); cmdOrder.push(e.commandTemplate); }
    }

    // Collect ordered worktree roots (insertion order)
    const wtOrder: string[] = [];
    const wtSet = new Set<string>();
    for (const e of group) {
      if (!wtSet.has(e.worktree)) { wtSet.add(e.worktree); wtOrder.push(e.worktree); }
    }

    const multiCmd = cmdOrder.length > 1;

    // Worktrees get only `root` — no id, no branch (both are runtime-derived)
    const worktrees = wtOrder.map((root) => ({ root }));

    // Shared remedies: only emit if identical across all entries in the group
    const remediesJson = group.map((e) => JSON.stringify(e.remedies ?? null));
    const sharedRemedies = remediesJson.every((r) => r === remediesJson[0]) ? first.remedies : undefined;

    slots.push({
      pos,
      value: {
        commandTemplate: multiCmd ? cmdOrder : cmdOrder[0]!,
        packagePath:     rel === "." ? "" : rel,
        packageLabel:    first.packageLabel,
        pm:              first.pm,
        script:          first.script,
        ...(sharedRemedies ? { remedies: sharedRemedies } : {}),
        worktrees,
      },
    });
  }

  for (const { pos, entry } of solo) {
    const { ephemeralPort: _port, ...rest } = entry;
    slots.push({ pos, value: rest });
  }
  return slots.sort((a, b) => a.pos - b.pos).map((s) => s.value);
}
