/**
 * RT-91 follow-up: refreshAllMRs is the seam cache-refresh.ts's deadline
 * AbortSignal reaches once the design/residue lanes merge. An already-aborted
 * signal must skip the GitLab/Linear round trip entirely rather than kick one
 * off just to discard the result.
 */

import { afterEach, expect, mock, spyOn, test } from "bun:test";

import * as linearModule from "../linear.ts";
import { refreshAllMRs } from "../enrich.ts";

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
