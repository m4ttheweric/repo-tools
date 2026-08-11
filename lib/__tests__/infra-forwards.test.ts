/**
 * RT-22: the daemon owns the infra forwards `rt sandbox create` depends on —
 * the receiver 2222 git-ssh endpoint (the create path's push) and the
 * controller 8080 API — with the same health/retry treatment as the pod
 * forwards. Before this, only `rt validate` held the receiver forward for
 * its own lifetime, so create failed with a refused push unless validate
 * happened to be running.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { infraForwardTargets, INFRA_NAMESPACE } from "../infra-forwards.ts";
import { receiverRepoUrl } from "../validate-farm.ts";

const ORIG_CONTROLLER = process.env.MC_CONTROLLER_URL;
const ORIG_RECEIVER = process.env.MC_RECEIVER_URL;
afterEach(() => {
  if (ORIG_CONTROLLER === undefined) delete process.env.MC_CONTROLLER_URL;
  else process.env.MC_CONTROLLER_URL = ORIG_CONTROLLER;
  if (ORIG_RECEIVER === undefined) delete process.env.MC_RECEIVER_URL;
  else process.env.MC_RECEIVER_URL = ORIG_RECEIVER;
});

describe("infraForwardTargets", () => {
  test("defaults: controller 8080 and receiver 2222 svc forwards", () => {
    delete process.env.MC_CONTROLLER_URL;
    delete process.env.MC_RECEIVER_URL;
    expect(INFRA_NAMESPACE).toBe("mc-system");
    expect(infraForwardTargets()).toEqual([
      { name: "controller", service: "controller", localPort: 8080, servicePort: 8080 },
      { name: "receiver", service: "receiver", localPort: 2222, servicePort: 2222 },
    ]);
  });

  test("a custom loopback port in the env URL moves the local leg only", () => {
    process.env.MC_RECEIVER_URL = "ssh://git@127.0.0.1:2422";
    const receiver = infraForwardTargets().find(t => t.name === "receiver");
    expect(receiver).toEqual({ name: "receiver", service: "receiver", localPort: 2422, servicePort: 2222 });
  });

  test("a non-loopback endpoint yields no target — the daemon must not forward for a remote endpoint", () => {
    process.env.MC_CONTROLLER_URL = "https://controller.mattcloud.example";
    process.env.MC_RECEIVER_URL = "ssh://git@receiver.mattcloud.example:22";
    expect(infraForwardTargets()).toEqual([]);
  });

  test("localhost (not just 127.0.0.1) still counts as loopback", () => {
    process.env.MC_RECEIVER_URL = "ssh://git@localhost:2222";
    expect(infraForwardTargets().some(t => t.name === "receiver")).toBe(true);
  });

  test("REGRESSION (push path): the receiver target's local port is the port pushSandboxBranch dials", () => {
    delete process.env.MC_RECEIVER_URL;
    const receiver = infraForwardTargets().find(t => t.name === "receiver")!;
    const pushUrl = receiverRepoUrl("assured-dev");
    const port = Number(pushUrl.match(/^ssh:\/\/[^@]+@[^:]+:(\d+)\//)![1]);
    expect(port).toBe(receiver.localPort);
  });
});
