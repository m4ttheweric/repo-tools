/**
 * The held-ready-ladder snapshot the tray polls (RT-98).
 *
 * `inspectReadyGate` walks the whole settings ladder three times per repo
 * (config, owning scope, approval) with synchronous file reads, and the tray
 * polls `tray:status` every 10 seconds. Recomputing that per poll puts N x 3
 * sync reads on the daemon's event loop every tick, which is the shape of
 * stall that shows up in the menu bar as a health flicker. So the snapshot is
 * memoized for a TTL well longer than the poll interval: a hold is a state
 * that persists for hours, and a minute of staleness costs nothing.
 */

import { lazyChildLogger } from "../daemon-logger.ts";
import { repoLabel } from "../repo-label.ts";
import { reverseLookupByName } from "../repo-name-lookup.ts";
import { parseIdentity } from "../settings/identity.ts";
import { inspectReadyGate, loadWorktreeRepoConfig } from "./config.ts";

const log = lazyChildLogger("worktree-ready-held");

/** Default staleness window. Six poll intervals at the tray's 10s cadence. */
const DEFAULT_TTL_MS = 60_000;

export interface ReadyHeldRepo {
  /** The repo-index key: a serialized repo identity. Never displayed. */
  repo: string;
  /** Display name, decoded from the identity. Never sent back as a key. */
  label: string;
  /** Content hash of the held ladder; a team edit changes it and re-arms. */
  hash: string;
  /** The exact command that clears this hold, resolvable as spelled. */
  approveCommand: string;
}

export interface HeldReadyLaddersOpts {
  ttlMs?: number;
  now?: () => number;
}

let cache: { at: number; value: ReadyHeldRepo[] } | null = null;

/** Test-only: drop the memo so a test can force recomputation. */
export function resetHeldReadyLaddersCache(): void {
  cache = null;
}

/**
 * The argument `rt worktree ready-approve` will actually resolve. A label is
 * what a human would type, so emit one whenever it resolves back to THIS repo,
 * and fall back to the identity (which always parses) when it does not.
 *
 * The matching runs through `reverseLookupByName`, the same rule
 * `resolveRepoArg` applies when the human runs the command, rather than a
 * second copy of it. A local copy drifted from that rule in two ways worth
 * naming: it matched only an identity TAIL, missing a collision with another
 * checkout's directory basename (which the resolver does match, and would call
 * ambiguous); and it deduped by raw path string rather than realpath.
 *
 * Deliberately NOT `tryResolveRepoArg`, though it is the resolver's own entry
 * point: this runs on the polled tray:status path, and that entry point
 * re-reads the repo index per call and routes a path-shaped argument through
 * `deriveRepoIdentity`, which spawns git. Taking the index the caller already
 * holds makes both impossible here rather than merely unlikely.
 */
function approveArg(repo: string, label: string, repoIndex: Record<string, string>): string {
  const canonical = canonicalKey(repo, repoIndex);
  const matches = reverseLookupByName(label, repoIndex);
  return matches.length === 1 && matches[0]![0] === canonical ? label : canonical;
}

/**
 * The identity for an index row: the key itself when it already parses, else a
 * sibling key naming the same directory that does.
 *
 * The fallback above leans on "the identity always parses", and that premise
 * fails for an unpruned legacy row, whose key is a plain name. Emitting one
 * produces a command that cannot resolve the moment any other checkout shares
 * the label, which is exactly when the fallback fires. No derivation here: a
 * sibling lookup is pure, and `deriveRepoIdentity` would spawn git on the
 * polled tray:status path.
 */
function canonicalKey(repo: string, repoIndex: Record<string, string>): string {
  if (parseIdentity(repo)) return repo;
  const path = repoIndex[repo];
  for (const [key, keyPath] of Object.entries(repoIndex)) {
    if (keyPath === path && parseIdentity(key)) return key;
  }
  return repo;
}

async function compute(repoIndex: Record<string, string>): Promise<ReadyHeldRepo[]> {
  const held: ReadyHeldRepo[] = [];
  for (const [repo, repoPath] of Object.entries(repoIndex)) {
    try {
      const cfg = await loadWorktreeRepoConfig(repo, repoPath);
      const info = await inspectReadyGate(cfg, repoPath);
      if (!info.teamOwned || info.approved) continue;
      const label = repoLabel(repo);
      held.push({
        repo,
        label,
        hash: info.hash,
        approveCommand: `rt worktree ready-approve ${approveArg(repo, label, repoIndex)}`,
      });
    } catch (err) {
      // One unreadable repo (moved, TCC-blocked) must not blank the snapshot
      // for every other repo on the machine.
      log.warn({ repo, err }, "ready-held: skipping repo whose ready gate could not be read");
    }
  }
  return held;
}

/**
 * Repos whose team-authored `ready` ladder is held pending approval, with the
 * hash `rt worktree ready-approve` would pin. Empty when nothing is held.
 */
export async function heldReadyLadders(
  repoIndex: Record<string, string>,
  opts: HeldReadyLaddersOpts = {},
): Promise<ReadyHeldRepo[]> {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const at = now();

  if (cache && at - cache.at < ttlMs) return cache.value;

  const value = await compute(repoIndex);
  cache = { at, value };
  return value;
}
