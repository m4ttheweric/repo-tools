/**
 * One snapshot engine per team clone under ~/.mattstack/teams. Clones
 * appear (team.join, team.create) and disappear while the daemon runs, so
 * the set is rescanned on a teams/ watch event, never fixed at boot.
 */

import { existsSync, readdirSync, readFileSync, watch as fsWatch } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import type { Logger } from "pino";

import { getSetting } from "../settings/resolve.ts";
import { mattstackHome } from "../rt-paths.ts";
import { createRealProbes, type Probes } from "../setup/probes.ts";
import { parseOriginUrl } from "../setup/team-settings.ts";
import { UserActionableError } from "../setup/errors.ts";
import {
  startSnapshot,
  teamSnapshotSpec,
  type HomeSnapshotSettings,
  type PullResult,
  type SnapshotHandle,
  type SnapshotStatus,
} from "./home-snapshot.ts";

export interface TeamSnapshotSettings extends HomeSnapshotSettings {
  pullIntervalSec: number;
}

export interface TeamSnapshotEntry extends SnapshotStatus {
  slug: string;
}

export interface TeamSnapshotsDeps {
  log: Logger;
  broadcast: (type: string, data: unknown) => void;
  teamsDir?: string;
  probes?: Probes;
  readSettings?: () => TeamSnapshotSettings;
  start?: typeof startSnapshot;
  watch?: (path: string, options: { recursive: boolean }, listener: (eventType: string, filename: string | null) => void) => { close(): void };
  setTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (h: ReturnType<typeof setTimeout>) => void;
  exec?: Parameters<typeof startSnapshot>[1]["exec"];
  db?: Database;
}

export interface TeamSnapshotsHandle {
  stop(): void;
  rescan(): Promise<void>;
  status(): TeamSnapshotEntry[];
  pullNow(slug: string): Promise<PullResult>;
  ready: Promise<void>;
}

const RESCAN_DEBOUNCE_MS = 2000;

function originOf(dir: string): string | null {
  try {
    return parseOriginUrl(readFileSync(join(dir, ".git", "config"), "utf8"));
  } catch {
    return null;
  }
}

export function startTeamSnapshots(rawDeps: TeamSnapshotsDeps): TeamSnapshotsHandle {
  const teamsDir = rawDeps.teamsDir ?? join(mattstackHome(), "teams");
  const probes = rawDeps.probes ?? createRealProbes();
  const start = rawDeps.start ?? startSnapshot;
  const watch = rawDeps.watch ?? (fsWatch as unknown as NonNullable<TeamSnapshotsDeps["watch"]>);
  const setTimer = rawDeps.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer = rawDeps.clearTimeout ?? ((h: ReturnType<typeof setTimeout>) => clearTimeout(h));
  const readSettings = rawDeps.readSettings ?? (() => getSetting<TeamSnapshotSettings>("rt.teamSnapshot").value);
  const instances = new Map<string, { handle: SnapshotHandle; dir: string }>();
  const skippedNoRemote = new Set<string>();
  let watcher: { close(): void } | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  /** A clone that gains its origin after boot (`rt team publish --remote`) edits .git/config, which the non-recursive teams/ watch never sees; this interval rescan, on the pull interval, is what picks it up. */
  function scheduleRescan(): void {
    if (stopped) return;
    interval = setTimer(() => { interval = null; void rescan().finally(scheduleRescan); }, Math.max(30, settings().pullIntervalSec) * 1000);
  }

  function settings(): TeamSnapshotSettings {
    try {
      return readSettings();
    } catch (err) {
      rawDeps.log.warn({ err }, "team-snapshots: failed to read rt.teamSnapshot; treating as enabled with defaults");
      return { enabled: true, debounceSec: 20, pushDelaySec: 60, janitorThresholdHours: 6, janitorIntervalMin: 30, pullIntervalSec: 300 };
    }
  }

  /** The engine reads home-shaped settings and clamps them itself; `pullIntervalSec` is the supervisor's alone and rides on the spec instead. */
  function snapshotSettings(s: TeamSnapshotSettings): HomeSnapshotSettings {
    const { pullIntervalSec: _pullIntervalSec, ...rest } = s;
    return rest;
  }

  async function rescan(): Promise<void> {
    if (stopped) return;
    const s = settings();
    if (s.enabled === false) {
      for (const [slug, inst] of instances) { inst.handle.stop(); instances.delete(slug); }
      return;
    }
    const present = new Set<string>();
    // A missing teams/ dir is the team-of-none case, not an error.
    if (existsSync(teamsDir)) {
      for (const slug of readdirSync(teamsDir).sort()) {
        const dir = join(teamsDir, slug);
        if (!existsSync(join(dir, ".git"))) continue;
        present.add(slug);
        if (instances.has(slug)) continue;
        const originUrl = originOf(dir);
        if (!originUrl) {
          if (!skippedNoRemote.has(slug)) {
            rawDeps.log.warn({ slug, dir }, "team-snapshots: clone has no origin; snapshotted once `rt team publish --remote` gives it one (picked up within the rescan interval)");
            skippedNoRemote.add(slug);
          }
          continue;
        }
        skippedNoRemote.delete(slug);
        const spec = teamSnapshotSpec(slug, dir, { pullIntervalSec: Math.max(30, s.pullIntervalSec), originUrl, probes });
        const handle = start(spec, {
          log: rawDeps.log.child({ team: slug }),
          broadcast: rawDeps.broadcast,
          exec: rawDeps.exec,
          watch: rawDeps.watch,
          setTimeout: rawDeps.setTimeout,
          clearTimeout: rawDeps.clearTimeout,
          db: rawDeps.db,
          readSettings: () => snapshotSettings(settings()),
        });
        instances.set(slug, { handle, dir });
        rawDeps.log.info({ slug }, "team-snapshots: watching");
      }
    }
    for (const [slug, inst] of instances) {
      if (!present.has(slug)) {
        inst.handle.stop();
        instances.delete(slug);
        rawDeps.log.info({ slug }, "team-snapshots: clone removed; stopped");
      }
    }
  }

  const ready = rescan().then(() => {
    if (stopped || settings().enabled === false) return;
    try {
      watcher = watch(teamsDir, { recursive: false }, () => {
        if (debounce) clearTimer(debounce);
        debounce = setTimer(() => { debounce = null; void rescan(); }, RESCAN_DEBOUNCE_MS);
      });
    } catch (err) {
      rawDeps.log.warn({ err, teamsDir }, "team-snapshots: cannot watch teams/; new clones are picked up on the interval rescan");
    }
    scheduleRescan();
  });

  return {
    ready,
    rescan,
    stop() {
      stopped = true;
      if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
      if (debounce) clearTimer(debounce);
      if (interval) clearTimer(interval);
      for (const inst of instances.values()) inst.handle.stop();
      instances.clear();
    },
    status: () => [...instances.entries()].map(([slug, inst]) => ({ slug, ...inst.handle.status() })),
    async pullNow(slug) {
      const inst = instances.get(slug);
      if (!inst) throw new UserActionableError("no-team", `team "${slug}" is not cloned locally (or has no origin)`);
      return inst.handle.pullNow();
    },
  };
}
