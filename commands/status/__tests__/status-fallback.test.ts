/**
 * rt status' no-daemon fallback, over state.db (RT-48, spec test 10 and spec
 * "No-daemon fallback": daemon absent + db present → served; db absent →
 * empty, no crash. "Status works daemonless" is the property).
 *
 * These tests run with NO daemon reachable: HOME is repointed at an empty
 * temp dir, so `~/.mattstack/rt/daemon.json` is absent, `isDaemonInstalled()`
 * is false, and `daemonQuery` returns null at its "not installed → silent
 * fallback" step — it never probes the tray or tries a restart on the
 * developer's real machine.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fetchStatusData } from "../data.ts";
import { getBranchCacheStore, openStateDb } from "../../../lib/state/index.ts";

let home: string;
let realHome: string | undefined;

beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "rt-status-fallback-"));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

function stateDbPath(): string {
  return join(home, ".mattstack", "rt", "state.db");
}

describe("rt status fallback (no daemon)", () => {
  test("db present: branch-cache rows are served from state.db", async () => {
    const dbPath = stateDbPath();
    mkdirSync(join(home, ".mattstack", "rt"), { recursive: true });
    const db = openStateDb(dbPath);
    getBranchCacheStore(db).put("feature/offline", {
      ticket: {
        id: "lin-1",
        identifier: "RT-48",
        title: "one sqlite state store",
        description: null,
        url: "https://linear.app/RT-48",
        stateName: "In Progress",
        stateColor: "#f2c94c",
        branchName: null,
      },
      linearId: "RT-48",
      mr: null,
      fetchedAt: 1_700_000_000_000,
      repoName: "repo-tools",
    });
    db.close();

    const data = await fetchStatusData();

    expect(data.source).toBe("cache-file");
    expect(Object.keys(data.branches)).toEqual(["feature/offline"]);
    const entry = data.branches["feature/offline"]!;
    expect(entry.linearId).toBe("RT-48");
    expect(entry.ticket?.title).toBe("one sqlite state store");
    expect(entry.repoName).toBe("repo-tools");
    expect(entry.fetchedAt).toBe(1_700_000_000_000);
    expect(data.ports).toEqual([]);
  });

  test("db absent: empty result, no crash, and no db is created by the read", async () => {
    expect(existsSync(stateDbPath())).toBe(false);

    const data = await fetchStatusData();

    expect(data.source).toBe("cache-file");
    expect(data.branches).toEqual({});
    expect(data.ports).toEqual([]);
    // A read-only dashboard must not create-and-migrate a state db as a side
    // effect — that is why the fallback gates on existsSync.
    expect(existsSync(stateDbPath())).toBe(false);
    const rtDirPath = join(home, ".mattstack", "rt");
    expect(existsSync(rtDirPath) ? readdirSync(rtDirPath) : []).toEqual([]);
  });

  test("an empty branch_cache table serves an empty dashboard", async () => {
    mkdirSync(join(home, ".mattstack", "rt"), { recursive: true });
    openStateDb(stateDbPath()).close();

    const data = await fetchStatusData();

    expect(data.source).toBe("cache-file");
    expect(data.branches).toEqual({});
  });
});
