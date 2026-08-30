/**
 * RT-91 follow-up: refreshAllMRs is the seam cache-refresh.ts's deadline
 * AbortSignal reaches once the design/residue lanes merge. An already-aborted
 * signal must skip the GitLab/Linear round trip entirely rather than kick one
 * off just to discard the result.
 *
 * CodeRabbit (PR #137): the entry-only check above is not enough — the
 * deadline can also fire WHILE a GitLab or Linear await is in flight. A
 * cycle that started before the deadline but resolves after it must still
 * discard its result instead of writing stale data over a newer cycle's row.
 */

import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import * as linearModule from "../linear.ts";
import { refreshAllMRs } from "../enrich.ts";
import { closeStateDb, getBranchCacheStore } from "../state/index.ts";
import { composeKey } from "../state/branch-cache.ts";

afterEach(() => {
  mock.restore();
});

test("an already-aborted signal skips the fetch entirely", async () => {
  const loadSecrets = spyOn(linearModule, "loadSecrets");

  const controller = new AbortController();
  controller.abort();

  await refreshAllMRs(
    [{ path: "/repo", branch: "feature/RT-91" }],
    "git@gitlab.com:acme/acme.git",
    undefined,
    "acme",
    controller.signal,
  );

  expect(loadSecrets).not.toHaveBeenCalled();
});

test("a signal that aborts mid-flight, during the Linear fetch, discards the result instead of writing it", async () => {
  let home: string | undefined;
  const realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "rt-enrich-abort-midflight-"));
  process.env.HOME = home;

  const controller = new AbortController();

  spyOn(linearModule, "loadSecrets").mockResolvedValue({ gitlabToken: undefined, linearApiKey: "key" } as any);
  spyOn(linearModule, "extractLinearId").mockReturnValue("RT-91");
  spyOn(linearModule, "fetchTicketsBatch").mockImplementation(async () => {
    // The deadline fires while this "network" call is in flight.
    controller.abort();
    return new Map([["RT-91", { id: "RT-91", title: "t", url: "u", state: "open" } as any]]);
  });

  try {
    await refreshAllMRs(
      [{ path: "/repo", branch: "feature/RT-91" }],
      undefined,
      undefined,
      "acme",
      controller.signal,
    );

    const entries = getBranchCacheStore().entries;
    expect(entries[composeKey("acme", "feature/RT-91")]).toBeUndefined();
  } finally {
    closeStateDb();
    process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  }
});
