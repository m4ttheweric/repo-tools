import { describe, expect, test } from "bun:test";

import {
  createDatabaseSql,
  dropDatabaseSql,
  localDumpSizeBytes,
  pushDatabase,
  readClusterCredentials,
  terminateConnectionsSql,
  type Exec,
  type ExecResult,
  type PortForwardHandle,
} from "../db-push.ts";

function fakeExec(script: Record<string, ExecResult>): { exec: Exec; calls: Array<{ argv: string[]; stdin?: string }> } {
  const calls: Array<{ argv: string[]; stdin?: string }> = [];
  const exec: Exec = async (argv, opts = {}) => {
    calls.push({ argv: [...argv], stdin: opts.stdin });
    for (const [prefix, result] of Object.entries(script)) {
      if (argv.join(" ").startsWith(prefix)) return result;
    }
    return { stdout: "", stderr: "no script match", exitCode: 127 };
  };
  return { exec, calls };
}

describe("readClusterCredentials", () => {
  test("decodes base64 username/password from the kubectl Secret JSON", async () => {
    const secretJson = JSON.stringify({
      data: {
        username: Buffer.from("acme").toString("base64"),
        password: Buffer.from("hunter2").toString("base64"),
      },
    });
    const { exec, calls } = fakeExec({
      "kubectl -n mc-system get secret postgres-credentials": { stdout: secretJson, stderr: "", exitCode: 0 },
    });

    const out = await readClusterCredentials(exec);

    expect(out).toEqual({ ok: true, creds: { username: "acme", password: "hunter2" } });
    expect(calls[0]!.argv).toEqual(["kubectl", "-n", "mc-system", "get", "secret", "postgres-credentials", "-o", "json"]);
  });

  test("fails clean when kubectl can't reach the cluster", async () => {
    const { exec } = fakeExec({
      "kubectl -n mc-system get secret postgres-credentials": { stdout: "", stderr: "Unable to connect", exitCode: 1 },
    });

    const out = await readClusterCredentials(exec);

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toContain("reachable");
      expect(out.message).toContain("kubeconfig-mattcloud.yaml");
    }
  });
});

describe("localDumpSizeBytes", () => {
  test("parses the byte count from the local psql query", async () => {
    const { exec, calls } = fakeExec({
      "psql postgres://postgres:postgres@localhost:5432/acme": { stdout: "148992\n", stderr: "", exitCode: 0 },
    });

    const size = await localDumpSizeBytes(exec);

    expect(size).toBe(148992);
    expect(calls[0]!.argv).toEqual(["psql", "postgres://postgres:postgres@localhost:5432/acme", "-tAc", "SELECT pg_database_size('acme');"]);
  });

  test("returns null when the local query fails (no local Postgres, etc.)", async () => {
    const { exec } = fakeExec({
      "psql postgres://postgres:postgres@localhost:5432/acme": { stdout: "", stderr: "psql: error: connection refused", exitCode: 2 },
    });

    const size = await localDumpSizeBytes(exec);

    expect(size).toBeNull();
  });
});

describe("SQL builders", () => {
  test("terminateConnectionsSql kills every other backend on the named db", () => {
    expect(terminateConnectionsSql("acme_tpl")).toBe(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'acme_tpl' AND pid <> pg_backend_pid();",
    );
  });

  test("dropDatabaseSql is idempotent (IF EXISTS)", () => {
    expect(dropDatabaseSql("acme_tpl")).toBe('DROP DATABASE IF EXISTS "acme_tpl";');
  });

  test("createDatabaseSql without a template", () => {
    expect(createDatabaseSql("acme_tpl")).toBe('CREATE DATABASE "acme_tpl";');
  });

  test("createDatabaseSql from a template", () => {
    expect(createDatabaseSql("acme", "acme_tpl")).toBe('CREATE DATABASE "acme" TEMPLATE "acme_tpl";');
  });
});

function fakeSpawnForward(): { spawnForward: () => PortForwardHandle; spawned: number } {
  let spawned = 0;
  const spawnForward = (): PortForwardHandle => {
    spawned++;
    return { kill: () => {}, exited: new Promise(() => {}) };
  };
  return { spawnForward, get spawned() { return spawned; } } as any;
}

describe("pushDatabase", () => {
  test("declining the confirmation prompt spawns no port-forward and runs no cluster command", async () => {
    // The dump-size probe (a read-only local psql query) is allowed before the
    // decline — it's what the confirm prompt shows the operator. Nothing else runs.
    const { exec, calls } = fakeExec({
      "psql postgres://postgres:postgres@localhost:5432/acme": { stdout: "0\n", stderr: "", exitCode: 0 },
    });
    const spawn = fakeSpawnForward();

    const out = await pushDatabase({
      exec,
      spawnForward: spawn.spawnForward,
      probe: async () => true,
      confirm: async () => false,
    });

    expect(out).toEqual({ ok: false, code: "declined", message: "push cancelled — nothing was touched" });
    expect(calls.every(c => c.argv[0] === "psql" && c.argv[1] === "postgres://postgres:postgres@localhost:5432/acme")).toBe(true);
    expect(spawn.spawned).toBe(0);
  });
});

describe("pushDatabase confirm summary", () => {
  test("names the cluster, local source db, and dump size before anything destructive", async () => {
    const { exec } = fakeExec({
      "psql postgres://postgres:postgres@localhost:5432/acme": { stdout: "148992\n", stderr: "", exitCode: 0 },
    });
    const summaries: Array<{ cluster: string; sourceDb: string; dumpSizeBytes: number | null }> = [];

    await pushDatabase({
      exec,
      spawnForward: () => ({ kill: () => {}, exited: new Promise(() => {}) }),
      probe: async () => true,
      confirm: async (summary) => {
        summaries.push(summary);
        return false;
      },
    });

    expect(summaries).toEqual([
      { cluster: "mattcloud cluster (mc-system/svc/postgres)", sourceDb: "local acme", dumpSizeBytes: 148992 },
    ]);
  });
});

describe("pushDatabase credentials", () => {
  test("a kubectl secret read failure hard-refuses before any port-forward", async () => {
    const { exec } = fakeExec({
      "psql postgres://postgres:postgres@localhost:5432/acme": { stdout: "0\n", stderr: "", exitCode: 0 },
      "kubectl -n mc-system get secret postgres-credentials": { stdout: "", stderr: "unreachable", exitCode: 1 },
    });
    const spawn = fakeSpawnForward();

    const out = await pushDatabase({
      exec,
      spawnForward: spawn.spawnForward,
      probe: async () => true,
      confirm: async () => true,
    });

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("unreachable");
      expect(out.message).toContain("kubeconfig-mattcloud.yaml");
    }
    expect(spawn.spawned).toBe(0);
  });
});

describe("pushDatabase port-forward", () => {
  test("hard-refuses when the postgres port-forward never comes up", async () => {
    const { exec } = fakeExec({
      "psql postgres://postgres:postgres@localhost:5432/acme": { stdout: "0\n", stderr: "", exitCode: 0 },
      "kubectl -n mc-system get secret postgres-credentials": {
        stdout: JSON.stringify({ data: { username: "YQ==", password: "Yg==" } }),
        stderr: "",
        exitCode: 0,
      },
    });
    const spawn = fakeSpawnForward();

    const out = await pushDatabase({
      exec,
      spawnForward: spawn.spawnForward,
      probe: async () => false,
      confirm: async () => true,
      delayMs: async () => {},
    });

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("unreachable");
      expect(out.message).toContain(String(15432));
    }
    expect(spawn.spawned).toBe(1);
  });
});

describe("local source URL", () => {
  test("pg_dump and the size query hit the default local TCP URL, never the bare socket", async () => {
    const { exec, calls } = fakeExec({
      "psql postgres://postgres:postgres@localhost:5432/acme": { stdout: "0\n", stderr: "", exitCode: 0 },
      "kubectl -n mc-system get secret postgres-credentials": {
        stdout: JSON.stringify({ data: { username: "YQ==", password: "Yg==" } }),
        stderr: "",
        exitCode: 0,
      },
      "pg_dump": { stdout: "-- dump content --", stderr: "", exitCode: 0 },
      "psql -h 127.0.0.1 -p 15432": { stdout: "", stderr: "", exitCode: 0 },
    });

    const out = await pushDatabase({
      exec,
      dumpFile: "/tmp/rt-test-dump.sql",
      spawnForward: () => ({ kill: () => {}, exited: new Promise(() => {}) }),
      probe: async () => true,
      confirm: async () => true,
    });

    expect(out.ok).toBe(true);
    const argvs = calls.map(c => c.argv.join(" "));
    expect(argvs).toContain(
      "pg_dump --no-owner --no-privileges -f /tmp/rt-test-dump.sql postgres://postgres:postgres@localhost:5432/acme",
    );
    expect(argvs.some(a => a === "pg_dump --no-owner --no-privileges acme")).toBe(false);
    expect(argvs.some(a => a.startsWith("psql -d acme"))).toBe(false);
  });

  test("a sourceUrl override reaches both local legs", async () => {
    const url = "postgres://me:pw@localhost:6543/acme";
    const { exec, calls } = fakeExec({
      [`psql ${url}`]: { stdout: "0\n", stderr: "", exitCode: 0 },
      "kubectl -n mc-system get secret postgres-credentials": {
        stdout: JSON.stringify({ data: { username: "YQ==", password: "Yg==" } }),
        stderr: "",
        exitCode: 0,
      },
      "pg_dump": { stdout: "-- dump content --", stderr: "", exitCode: 0 },
      "psql -h 127.0.0.1 -p 15432": { stdout: "", stderr: "", exitCode: 0 },
    });

    const out = await pushDatabase({
      exec,
      sourceUrl: url,
      dumpFile: "/tmp/rt-test-dump.sql",
      spawnForward: () => ({ kill: () => {}, exited: new Promise(() => {}) }),
      probe: async () => true,
      confirm: async () => true,
    });

    expect(out.ok).toBe(true);
    const argvs = calls.map(c => c.argv.join(" "));
    expect(argvs).toContain(`pg_dump --no-owner --no-privileges -f /tmp/rt-test-dump.sql ${url}`);
    expect(argvs).toContain(`psql ${url} -tAc SELECT pg_database_size('acme');`);
  });
});

describe("version-matched dumper", () => {
  test("dumpVia.docker runs pg_dump inside the source container, streaming to the host spool", async () => {
    // The host pg_dump can be newer than both servers (18 vs 16), and a v18
    // dump emits SET transaction_timeout, which PG16 rejects on restore. The
    // container's own binary always matches the source server.
    const { exec, calls } = fakeExec({
      "psql postgres://postgres:postgres@localhost:5432/acme": { stdout: "0\n", stderr: "", exitCode: 0 },
      "kubectl -n mc-system get secret postgres-credentials": {
        stdout: JSON.stringify({ data: { username: "YQ==", password: "Yg==" } }),
        stderr: "",
        exitCode: 0,
      },
      "sh -c": { stdout: "", stderr: "", exitCode: 0 },
      "psql -h 127.0.0.1 -p 15432": { stdout: "", stderr: "", exitCode: 0 },
      "rm -f": { stdout: "", stderr: "", exitCode: 0 },
    });

    const out = await pushDatabase({
      exec,
      dumpVia: { docker: "acme-db-1" },
      dumpFile: "/tmp/rt-test-dump.sql",
      spawnForward: () => ({ kill: () => {}, exited: new Promise(() => {}) }),
      probe: async () => true,
      confirm: async () => true,
    });

    expect(out.ok).toBe(true);
    const argvs = calls.map(c => c.argv.join(" "));
    const dumpCall = argvs.find(a => a.startsWith("sh -c"));
    expect(dumpCall).toBeDefined();
    expect(dumpCall).toContain("docker exec 'acme-db-1' pg_dump");
    expect(dumpCall).toContain("--no-owner --no-privileges");
    expect(dumpCall).toContain("> '/tmp/rt-test-dump.sql'");
    expect(argvs.some(a => a.startsWith("pg_dump "))).toBe(false);
  });
});

describe("pushDatabase happy path", () => {
  function happyScript(): Record<string, ExecResult> {
    return {
      "psql postgres://postgres:postgres@localhost:5432/acme": { stdout: "0\n", stderr: "", exitCode: 0 },
      "kubectl -n mc-system get secret postgres-credentials": {
        stdout: JSON.stringify({ data: { username: "YQ==", password: "Yg==" } }),
        stderr: "",
        exitCode: 0,
      },
      "pg_dump": { stdout: "-- dump content --", stderr: "", exitCode: 0 },
      "psql -h 127.0.0.1 -p 15432": { stdout: "", stderr: "", exitCode: 0 },
    };
  }

  test("dumps local acme, restores into acme_tpl, then recreates live acme from it", async () => {
    const { exec, calls } = fakeExec(happyScript());
    const phases: Array<{ phase: string }> = [];

    const out = await pushDatabase({
      exec,
      dumpFile: "/tmp/rt-test-dump.sql",
      spawnForward: () => ({ kill: () => {}, exited: new Promise(() => {}) }),
      probe: async () => true,
      confirm: async () => true,
      onPhase: (phase) => phases.push({ phase }),
    });

    expect(out.ok).toBe(true);

    const argvs = calls.map(c => c.argv.join(" "));
    // pg_dump streams to the dump file before any cluster mutation -- the dump
    // is never buffered in memory (a 10GB dump killed the allocator).
    expect(argvs).toContain(
      "pg_dump --no-owner --no-privileges -f /tmp/rt-test-dump.sql postgres://postgres:postgres@localhost:5432/acme",
    );
    const dumpIdx = argvs.findIndex(a => a.startsWith("pg_dump"));

    // The template is torn down and rebuilt from the dump, after the dump.
    const tplTerminate = argvs.indexOf(
      `psql -h 127.0.0.1 -p 15432 -U a -d postgres -v ON_ERROR_STOP=1 -c SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'acme_tpl' AND pid <> pg_backend_pid();`,
    );
    const tplDrop = argvs.indexOf(`psql -h 127.0.0.1 -p 15432 -U a -d postgres -v ON_ERROR_STOP=1 -c DROP DATABASE IF EXISTS "acme_tpl";`);
    const tplCreate = argvs.indexOf(`psql -h 127.0.0.1 -p 15432 -U a -d postgres -v ON_ERROR_STOP=1 -c CREATE DATABASE "acme_tpl";`);
    const tplRestore = argvs.indexOf(
      `psql -h 127.0.0.1 -p 15432 -U a -d acme_tpl -v ON_ERROR_STOP=1 -f /tmp/rt-test-dump.sql`,
    );
    expect(dumpIdx).toBeGreaterThanOrEqual(0);
    expect(tplTerminate).toBeGreaterThan(dumpIdx);
    expect(tplDrop).toBeGreaterThan(tplTerminate);
    expect(tplCreate).toBeGreaterThan(tplDrop);
    expect(tplRestore).toBeGreaterThan(tplCreate);
    expect(calls[tplRestore]!.stdin).toBeUndefined();

    // The dump file is cleaned up after a successful push.
    expect(argvs).toContain("rm -f /tmp/rt-test-dump.sql");
    expect(argvs.indexOf("rm -f /tmp/rt-test-dump.sql")).toBeGreaterThan(tplRestore);

    // Then the live db is torn down and recreated FROM the template, server-side.
    const liveTerminate = argvs.indexOf(
      `psql -h 127.0.0.1 -p 15432 -U a -d postgres -v ON_ERROR_STOP=1 -c SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'acme' AND pid <> pg_backend_pid();`,
    );
    const liveDrop = argvs.indexOf(`psql -h 127.0.0.1 -p 15432 -U a -d postgres -v ON_ERROR_STOP=1 -c DROP DATABASE IF EXISTS "acme";`);
    const liveCreate = argvs.indexOf(`psql -h 127.0.0.1 -p 15432 -U a -d postgres -v ON_ERROR_STOP=1 -c CREATE DATABASE "acme" TEMPLATE "acme_tpl";`);
    expect(liveTerminate).toBeGreaterThan(tplRestore);
    expect(liveDrop).toBeGreaterThan(liveTerminate);
    expect(liveCreate).toBeGreaterThan(liveDrop);

    // Streamed progress: at least one phase per major step, in order.
    expect(phases.length).toBeGreaterThanOrEqual(3);

    if (out.ok) {
      expect(out.message).toContain("acme_tpl");
      expect(out.message.toLowerCase()).toContain("recover");
    }
  });
});

describe("pushDatabase failures mid-flight", () => {
  function baseScript(): Record<string, ExecResult> {
    return {
      "psql postgres://postgres:postgres@localhost:5432/acme": { stdout: "0\n", stderr: "", exitCode: 0 },
      "kubectl -n mc-system get secret postgres-credentials": {
        stdout: JSON.stringify({ data: { username: "YQ==", password: "Yg==" } }),
        stderr: "",
        exitCode: 0,
      },
    };
  }

  test("a pg_dump failure surfaces stderr and never touches the cluster", async () => {
    const { exec, calls } = fakeExec({
      ...baseScript(),
      "pg_dump": { stdout: "", stderr: "pg_dump: error: connection refused", exitCode: 1 },
    });

    const out = await pushDatabase({
      exec,
      spawnForward: () => ({ kill: () => {}, exited: new Promise(() => {}) }),
      probe: async () => true,
      confirm: async () => true,
    });

    expect(out).toEqual({ ok: false, code: "tooling", message: "pg_dump failed: pg_dump: error: connection refused" });
    expect(calls.some(c => c.argv.join(" ").includes("DROP DATABASE"))).toBe(false);
  });

  test("a failed template restore reports the failure without touching the live db", async () => {
    const { exec, calls } = fakeExec({
      ...baseScript(),
      "pg_dump": { stdout: "-- dump --", stderr: "", exitCode: 0 },
      "psql -h 127.0.0.1 -p 15432 -U a -d postgres -v ON_ERROR_STOP=1 -c DROP DATABASE IF EXISTS \"acme_tpl\";": { stdout: "", stderr: "", exitCode: 0 },
      "psql -h 127.0.0.1 -p 15432 -U a -d postgres -v ON_ERROR_STOP=1 -c CREATE DATABASE \"acme_tpl\";": { stdout: "", stderr: "", exitCode: 0 },
      "psql -h 127.0.0.1 -p 15432 -U a -d postgres -v ON_ERROR_STOP=1 -c SELECT pg_terminate_backend": { stdout: "", stderr: "", exitCode: 0 },
      "psql -h 127.0.0.1 -p 15432 -U a -d acme_tpl -v ON_ERROR_STOP=1": { stdout: "", stderr: "syntax error near FOO", exitCode: 3 },
    });

    const out = await pushDatabase({
      exec,
      spawnForward: () => ({ kill: () => {}, exited: new Promise(() => {}) }),
      probe: async () => true,
      confirm: async () => true,
    });

    expect(out).toEqual({
      ok: false,
      code: "cluster",
      message: expect.stringContaining("restore into acme_tpl failed: syntax error near FOO"),
    });
    expect(calls.some(c => c.argv.join(" ").includes(`DROP DATABASE IF EXISTS "acme";`))).toBe(false);
  });

  test("a failed live recreate names the recovery path (acme_tpl still holds the fresh dump)", async () => {
    const { exec } = fakeExec({
      ...baseScript(),
      "pg_dump": { stdout: "-- dump --", stderr: "", exitCode: 0 },
      "psql -h 127.0.0.1 -p 15432 -U a -d acme_tpl -v ON_ERROR_STOP=1": { stdout: "", stderr: "", exitCode: 0 },
      "psql -h 127.0.0.1 -p 15432 -U a -d postgres -v ON_ERROR_STOP=1 -c CREATE DATABASE \"acme\" TEMPLATE \"acme_tpl\";": {
        stdout: "",
        stderr: "database is being accessed by other users",
        exitCode: 1,
      },
      "psql -h 127.0.0.1 -p 15432 -U a -d postgres -v ON_ERROR_STOP=1": { stdout: "", stderr: "", exitCode: 0 },
    });

    const out = await pushDatabase({
      exec,
      spawnForward: () => ({ kill: () => {}, exited: new Promise(() => {}) }),
      probe: async () => true,
      confirm: async () => true,
    });

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("cluster");
      expect(out.message).toContain("database is being accessed by other users");
      expect(out.message).toContain("acme_tpl still holds the fresh dump");
      expect(out.message).toContain("rt db push");
    }
  });
});
