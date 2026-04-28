/**
 * Compact↔expanded LaneEntry transform.
 *
 * The on-disk runner config collapses repetitive entries (same package, different
 * worktrees or command variants) into grouped objects. This file owns that
 * bidirectional transform:
 *
 *   compactEntries(LaneEntry[]) → any[]   (write path, grouped disk-shape)
 *   compactLaneEntry(...)       → any | undefined   (write path, singular lane entry)
 *   normalizeEntry(any)         → LaneEntry[]   (read path, singular raw entry)
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
 *                    (one runtime entry per worktree; commands become a menu)
 *
 * Any command variant (the bare field or an array element) can also be an
 * object `{ cmd, alias? }` — `alias` becomes a UI label and round-trips back
 * to the object form on save.
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
 * Parse a commandTemplate variant into its cmd/alias pair.
 * Accepts a bare string (no alias) or `{ cmd, alias? }`. Unknown shapes
 * coerce to a string so round-tripping never throws on malformed input.
 */
function parseCmd(raw: any): { cmd: string; alias?: string } {
  if (raw && typeof raw === "object" && typeof raw.cmd === "string") {
    return typeof raw.alias === "string" && raw.alias
      ? { cmd: raw.cmd, alias: raw.alias }
      : { cmd: raw.cmd };
  }
  return { cmd: String(raw ?? "") };
}

/**
 * Expand a compact entry (has `worktrees` array) into individual LaneEntry objects.
 *
 * When `commandTemplate` is an array, the variants form a *menu* — one per
 * entry is active (selected by `activeCmdIdx`, default 0) and the full list
 * is carried on every expanded entry as `availableCommands` so the runner's
 * [l][c] picker can switch templates without re-reading disk.
 *
 * Earlier versions fanned the cross-product (cmds × worktrees). That produced
 * N*M visible rows and stopped scaling past a handful of worktrees — now the
 * picker covers it instead.
 *
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

  // Normalise commandTemplate → always { cmd, alias? }[]
  const rawCmd = raw.commandTemplate;
  const rawCmds: any[] = Array.isArray(rawCmd)
    ? rawCmd
    : [rawCmd ?? (pm && script ? `${pm} run ${script}` : "")];
  const commands = rawCmds.map(parseCmd);

  const activeIdxRaw = Number(raw.activeCmdIdx ?? 0);
  const activeIdx = Number.isFinite(activeIdxRaw) && activeIdxRaw >= 0 && activeIdxRaw < commands.length
    ? activeIdxRaw
    : 0;
  const active = commands[activeIdx]!;
  const hasMenu = commands.length > 1;
  // Strip undefined aliases when forwarding to availableCommands so the
  // on-disk round-trip stays minimal.
  const availableCommands = hasMenu
    ? commands.map((c) => c.alias ? { cmd: c.cmd, alias: c.alias } : { cmd: c.cmd })
    : undefined;

  const entries: LaneEntry[] = [];
  for (const wt of raw.worktrees as any[]) {
    const root      = String(wt.root ?? "");
    const targetDir = packagePath && packagePath !== "." ? `${root}/${packagePath}` : root;
    entries.push({
      id:              worktreeEntryId(root, 0),
      targetDir,
      pm,
      script,
      packageLabel,
      worktree:        root,
      branch:          "",  // populated at runtime by git watcher
      ephemeralPort:   0,   // allocated at runtime by port allocator
      commandTemplate: active.cmd,
      ...(active.alias ? { alias: active.alias } : {}),
      ...(availableCommands ? { availableCommands } : {}),
      ...(remedies ? { remedies } : {}),
    } satisfies LaneEntry);
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
  // commandTemplate on an expanded entry can also be the object form;
  // a top-level `alias` field takes precedence if present.
  const parsed = raw.commandTemplate !== undefined
    ? parseCmd(raw.commandTemplate)
    : { cmd: pm && script ? `${pm} run ${script}` : "" };
  const alias = typeof raw.alias === "string" && raw.alias ? raw.alias : parsed.alias;
  const availableCommands: Array<{ cmd: string; alias?: string }> | undefined = Array.isArray(raw.availableCommands)
    ? (raw.availableCommands as any[]).map((r): { cmd: string; alias?: string } => {
        const parsed = parseCmd(r);
        return parsed.alias ? { cmd: parsed.cmd, alias: parsed.alias } : { cmd: parsed.cmd };
      })
    : undefined;
  return {
    id,
    targetDir:       String(raw.targetDir ?? ""),
    pm,
    script,
    packageLabel:    String(raw.packageLabel ?? ""),
    worktree,
    branch:          "",  // populated at runtime
    ephemeralPort:   0,   // allocated at runtime
    commandTemplate: parsed.cmd,
    ...(alias ? { alias } : {}),
    ...(availableCommands && availableCommands.length > 1 ? { availableCommands } : {}),
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

    const encodeCmd = (cmd: string, alias: string | undefined) =>
      alias ? { cmd, alias } : cmd;

    if (group.length === 1) {
      // True singleton — keep as expanded object, strip ephemeralPort.
      // Fold `alias` into the object form of commandTemplate so disk shape stays uniform.
      const { ephemeralPort: _port, alias, commandTemplate, availableCommands, ...rest } = first;
      const singletonValue: any = { ...rest };
      if (availableCommands && availableCommands.length > 1) {
        singletonValue.commandTemplate = availableCommands.map((c) => encodeCmd(c.cmd, c.alias));
        const activeIdx = availableCommands.findIndex((c) => c.cmd === commandTemplate);
        if (activeIdx > 0) singletonValue.activeCmdIdx = activeIdx;
      } else {
        singletonValue.commandTemplate = encodeCmd(commandTemplate, alias);
      }
      slots.push({ pos, value: singletonValue });
      continue;
    }

    // Worktree entries in the same group now share one active cmd (menu
    // lives on `availableCommands`). Prefer the menu when present; fall
    // back to collecting distinct cmds for legacy/manually-constructed input.
    const menu = first.availableCommands;
    let cmdOut: any;
    let activeCmdIdx: number | undefined;
    if (menu && menu.length > 1) {
      cmdOut = menu.map((c) => encodeCmd(c.cmd, c.alias));
      const idx = menu.findIndex((c) => c.cmd === first.commandTemplate);
      if (idx > 0) activeCmdIdx = idx;
    } else {
      const cmdOrder: string[] = [];
      const aliasByCmd = new Map<string, string | undefined>();
      for (const e of group) {
        if (!aliasByCmd.has(e.commandTemplate)) {
          cmdOrder.push(e.commandTemplate);
          aliasByCmd.set(e.commandTemplate, e.alias);
        }
      }
      cmdOut = cmdOrder.length > 1
        ? cmdOrder.map((c) => encodeCmd(c, aliasByCmd.get(c)))
        : encodeCmd(cmdOrder[0]!, aliasByCmd.get(cmdOrder[0]!));
    }

    // Collect ordered worktree roots (insertion order)
    const wtOrder: string[] = [];
    const wtSet = new Set<string>();
    for (const e of group) {
      if (!wtSet.has(e.worktree)) { wtSet.add(e.worktree); wtOrder.push(e.worktree); }
    }

    // Worktrees get only `root` — no id, no branch (both are runtime-derived)
    const worktrees = wtOrder.map((root) => ({ root }));

    // Shared remedies: only emit if identical across all entries in the group
    const remediesJson = group.map((e) => JSON.stringify(e.remedies ?? null));
    const sharedRemedies = remediesJson.every((r) => r === remediesJson[0]) ? first.remedies : undefined;

    slots.push({
      pos,
      value: {
        commandTemplate: cmdOut,
        ...(activeCmdIdx !== undefined ? { activeCmdIdx } : {}),
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
    const { ephemeralPort: _port, alias, commandTemplate, availableCommands, ...rest } = entry;
    const soloValue: any = { ...rest };
    if (availableCommands && availableCommands.length > 1) {
      soloValue.commandTemplate = availableCommands.map((c) => c.alias ? { cmd: c.cmd, alias: c.alias } : c.cmd);
      const idx = availableCommands.findIndex((c) => c.cmd === commandTemplate);
      if (idx > 0) soloValue.activeCmdIdx = idx;
    } else {
      soloValue.commandTemplate = alias ? { cmd: commandTemplate, alias } : commandTemplate;
    }
    slots.push({ pos, value: soloValue });
  }
  return slots.sort((a, b) => a.pos - b.pos).map((s) => s.value);
}

/**
 * Compact a lane's runtime entries into the singular persisted `entry` object.
 *
 * A lane is intentionally one service definition across worktrees. Multiple
 * compacted objects mean the lane contains independent service groups, which
 * the singular config cannot represent without reintroducing ambiguity.
 */
export function compactLaneEntry(entries: LaneEntry[]): any | undefined {
  const compacted = compactEntries(entries);
  if (compacted.length === 0) return undefined;
  if (compacted.length > 1) {
    throw new Error("runner lane can only persist one entry group");
  }
  return compacted[0];
}
