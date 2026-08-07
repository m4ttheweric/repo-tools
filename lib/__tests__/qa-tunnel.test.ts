import { describe, expect, test } from "bun:test";

import {
  QA_CLUSTER_HOST,
  openQaTunnel,
  parseReceiverSsh,
  qaPostgresUrl,
  qaTunnelArgv,
  upsertEnvSecret,
  type TunnelSpawn,
} from "../qa-tunnel.ts";
import type { Exec, ExecResult } from "../cloud-secrets.ts";

function fakeExec(script: Record<string, ExecResult>): { exec: Exec; calls: Array<{ argv: string[]; stdin?: string }> } {
  const calls: Array<{ argv: string[]; stdin?: string }> = [];
  const exec: Exec = async (argv, opts = {}) => {
    calls.push({ argv: [...argv], stdin: opts.stdin });
    for (const [prefix, result] of Object.entries(script)) {
      if (argv.join(" ").startsWith(prefix)) return result;
    }
    return { stdout: "", exitCode: 127 };
  };
  return { exec, calls };
}

describe("parseReceiverSsh", () => {
  test("splits the ssh:// receiver URL into user/host/port", () => {
    expect(parseReceiverSsh("ssh://git@localhost:2222")).toEqual({ user: "git", host: "localhost", port: 2222 });
    expect(parseReceiverSsh("ssh://git@receiver.example.com")).toEqual({ user: "git", host: "receiver.example.com", port: 22 });
  });
});

describe("qaTunnelArgv", () => {
  test("ssh -N -R through the receiver, key pinned when given", () => {
    expect(qaTunnelArgv({
      clusterPort: 15432,
      localPort: 5433,
      receiverUrl: "ssh://git@localhost:2222",
      sshKey: "/key",
    })).toEqual([
      "ssh", "-i", "/key", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new",
      "-N", "-R", "15432:127.0.0.1:5433", "-p", "2222", "git@localhost",
    ]);
  });

  test("without a key, ssh's own resolution is left alone", () => {
    expect(qaTunnelArgv({ clusterPort: 1, localPort: 2, receiverUrl: "ssh://git@h:22" })).toEqual([
      "ssh", "-N", "-R", "1:127.0.0.1:2", "-p", "22", "git@h",
    ]);
  });
});

describe("qaPostgresUrl", () => {
  test("default template targets the receiver service at the cluster port", () => {
    expect(qaPostgresUrl(undefined, 15432)).toBe(`postgresql://${QA_CLUSTER_HOST}:15432/postgres`);
  });

  test("overlay template substitutes {host} and {port}", () => {
    expect(qaPostgresUrl("postgres://qa:{port}@{host}/claims", 15432)).toBe(
      `postgres://qa:15432@${QA_CLUSTER_HOST}/claims`,
    );
  });
});

describe("upsertEnvSecret", () => {
  test("applies sandbox-<id>-env with dotenv content via kubectl stdin", async () => {
    const { exec, calls } = fakeExec({
      "kubectl -n mc-sandboxes apply": { stdout: "ok", exitCode: 0 },
    });
    const out = await upsertEnvSecret({
      sandboxId: "sb-1",
      env: { POSTGRES_URL: "postgresql://h:1/x" },
      exec,
    });
    expect(out.exitCode).toBe(0);
    const manifest = JSON.parse(calls[0]!.stdin!);
    expect(manifest.metadata.name).toBe("sandbox-sb-1-env");
    expect(manifest.stringData.env).toBe("POSTGRES_URL=postgresql://h:1/x\n");
  });
});

describe("openQaTunnel", () => {
  function world(opts: { listenerUp?: boolean; applyExit?: number } = {}) {
    const spawned: Array<{ argv: string[]; killed: boolean }> = [];
    let dieTunnel!: (code: number) => void;
    const spawn: TunnelSpawn = (argv) => {
      const entry = { argv, killed: false };
      spawned.push(entry);
      return {
        kill: () => { entry.killed = true; },
        exited: new Promise<number>(resolve => { dieTunnel = resolve; }),
      };
    };
    const { exec, calls } = fakeExec({
      kubectl: { stdout: "ok", exitCode: opts.applyExit ?? 0 },
    });
    return {
      spawned,
      calls,
      dieTunnel: (code: number) => dieTunnel(code),
      open: (onDeath?: (code: number) => void) => openQaTunnel({
        sandboxId: "sb-1",
        localPort: 5433,
        probeListener: async () => opts.listenerUp ?? true,
        spawn,
        exec,
        env: { MC_RECEIVER_URL: "ssh://git@localhost:2222", MC_RECEIVER_SSH_KEY: "/key" },
        ...(onDeath ? { onDeath } : {}),
      }),
    };
  }

  test("preflight failure refuses before spawning anything (credential stays local)", async () => {
    const w = world({ listenerUp: false });
    const out = await w.open();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("5433");
    expect(w.spawned).toHaveLength(0);
    expect(w.calls).toHaveLength(0);
  });

  test("opens ssh -R and injects POSTGRES_URL via the env Secret, with the recycle contract", async () => {
    const w = world();
    const out = await w.open();
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.postgresUrl).toBe(`postgresql://${QA_CLUSTER_HOST}:15432/postgres`);
      expect(w.spawned[0]!.argv).toContain("15432:127.0.0.1:5433");
      expect(w.spawned[0]!.argv).toContain("git@localhost");
      const manifest = JSON.parse(w.calls[0]!.stdin!);
      expect(manifest.stringData.env).toContain("POSTGRES_URL=");
    }
  });

  test("a failed Secret upsert tears the tunnel down again", async () => {
    const w = world({ applyExit: 1 });
    const out = await w.open();
    expect(out.ok).toBe(false);
    expect(w.spawned[0]!.killed).toBe(true);
  });

  test("tunnel death invokes onDeath with the exit code", async () => {
    const w = world();
    const deaths: number[] = [];
    await w.open(code => deaths.push(code));
    w.dieTunnel(255);
    await Bun.sleep(0);
    expect(deaths).toEqual([255]);
  });
});
