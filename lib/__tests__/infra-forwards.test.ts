/**
 * RT-22: the daemon owns the infra forwards `rt sandbox create` depends on —
 * the receiver 2222 git-ssh endpoint (the create path's push) and the
 * controller 8080 API — with the same health/retry treatment as the pod
 * forwards. Before this, only `rt validate` held the receiver forward for
 * its own lifetime, so create failed with a refused push unless validate
 * happened to be running.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  createInfraForwardSet,
  infraForwardTargets,
  INFRA_NAMESPACE,
  type InfraForwardTarget,
} from "../infra-forwards.ts";
import { receiverRepoUrl } from "../validate-farm.ts";
import type { ForwardSpawn } from "../sandbox-allocator.ts";

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
    const pushUrl = receiverRepoUrl("acme-dev");
    const port = Number(pushUrl.match(/^ssh:\/\/[^@]+@[^:]+:(\d+)\//)![1]);
    expect(port).toBe(receiver.localPort);
  });
});

// ─── createInfraForwardSet ───────────────────────────────────────────────────

const TARGETS: InfraForwardTarget[] = [
  { name: "controller", service: "controller", localPort: 8080, servicePort: 8080 },
  { name: "receiver", service: "receiver", localPort: 2222, servicePort: 2222 },
];

function recordingSpawn() {
  const spawned: Array<{ argv: string[]; killed: boolean; dead: boolean }> = [];
  const spawn: ForwardSpawn = (argv) => {
    const entry = { argv, killed: false, dead: false };
    spawned.push(entry);
    return { kill: () => { entry.killed = true; }, alive: () => !entry.killed && !entry.dead };
  };
  return { spawn, spawned };
}

describe("createInfraForwardSet", () => {
  test("ensureOnce spawns one kubectl svc port-forward per unserved target", async () => {
    const { spawn, spawned } = recordingSpawn();
    const set = createInfraForwardSet({ targets: TARGETS, spawn, listens: async () => false });
    const outcomes = await set.ensureOnce();
    expect(outcomes).toEqual([
      { name: "controller", outcome: "spawned" },
      { name: "receiver", outcome: "spawned" },
    ]);
    expect(spawned.map(s => s.argv)).toEqual([
      ["kubectl", "-n", "mc-system", "port-forward", "svc/controller", "8080:8080"],
      ["kubectl", "-n", "mc-system", "port-forward", "svc/receiver", "2222:2222"],
    ]);
  });

  test("a live child is kept — no respawn churn on the healthy path", async () => {
    const { spawn, spawned } = recordingSpawn();
    const set = createInfraForwardSet({ targets: TARGETS, spawn, listens: async () => false });
    await set.ensureOnce();
    const outcomes = await set.ensureOnce();
    expect(outcomes).toEqual([
      { name: "controller", outcome: "kept" },
      { name: "receiver", outcome: "kept" },
    ]);
    expect(spawned).toHaveLength(2);
  });

  test("a foreign listener on the port is respected — rt validate's or a manual forward keeps the bind", async () => {
    const { spawn, spawned } = recordingSpawn();
    let foreign = true;
    const set = createInfraForwardSet({ targets: TARGETS, spawn, listens: async () => foreign });
    expect(await set.ensureOnce()).toEqual([
      { name: "controller", outcome: "foreign" },
      { name: "receiver", outcome: "foreign" },
    ]);
    expect(spawned).toHaveLength(0);
    // The foreign holder went away (validate finished): the daemon takes over.
    foreign = false;
    expect(await set.ensureOnce()).toEqual([
      { name: "controller", outcome: "spawned" },
      { name: "receiver", outcome: "spawned" },
    ]);
    expect(spawned).toHaveLength(2);
  });

  test("our own live child never reads as foreign even though it listens", async () => {
    const { spawn, spawned } = recordingSpawn();
    let listening = false;
    const set = createInfraForwardSet({ targets: TARGETS, spawn, listens: async () => listening });
    await set.ensureOnce();
    listening = true; // the spawned kubectl children now hold the ports
    expect(await set.ensureOnce()).toEqual([
      { name: "controller", outcome: "kept" },
      { name: "receiver", outcome: "kept" },
    ]);
    expect(spawned).toHaveLength(2);
  });
});
