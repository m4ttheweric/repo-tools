import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSandboxClient,
  createSandboxFlow,
  findSandboxAnchor,
  listSandboxOverlays,
  parseFlagValues,
  pushSandboxBranch,
  sandboxLogsArgv,
  readSandboxAnchor,
  readSandboxConfig,
  removeSandboxAnchor,
  sandboxIncomingRef,
  upsertFlagsSecret,
  writeSandboxAnchor,
  type SandboxAnchor,
  type SandboxDetail,
  type SandboxEvent,
} from "../sandbox.ts";
import type { Exec, ExecResult } from "../cloud-secrets.ts";

// Several helpers resolve HOME at call time (rt-paths convention); restore it
// after every test so a repointed HOME can't leak into other files' tests.
const ORIG_HOME = process.env.HOME;
afterEach(() => { process.env.HOME = ORIG_HOME; });

// ─── Fakes ───────────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

/** Fake fetch that scripts responses per `METHOD url-suffix` and records calls. */
function fakeFetch(script: Record<string, { status: number; json?: unknown; text?: string }>) {
  const calls: FetchCall[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url: String(url),
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    for (const [key, res] of Object.entries(script)) {
      const [m, suffix] = key.split(" ", 2);
      if (method === m && String(url).endsWith(suffix!)) {
        return new Response(
          res.text ?? JSON.stringify(res.json ?? {}),
          { status: res.status },
        );
      }
    }
    return new Response("unmatched", { status: 500 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

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

const DETAIL: SandboxDetail = {
  id: "sb-1",
  repoId: "acme-dev",
  branch: "cv-1-fix",
  imageTag: "acme-dev-sandbox:2026-08-07",
  state: "running",
  createdAt: "2026-08-07T00:00:00.000Z",
  ports: { backend: 4000, adjuster: 4001 },
  lastEventSeq: 0,
  podPhase: "Running",
  containers: [{ name: "agent", ready: true }],
};

// ─── Controller client ───────────────────────────────────────────────────────

describe("createSandboxClient", () => {
  test("create POSTs the spec body verbatim and returns the sandboxId", async () => {
    const { fetchFn, calls } = fakeFetch({
      "POST /sandboxes": { status: 200, json: { sandboxId: "sb-1" } },
    });
    const client = createSandboxClient("http://c", fetchFn);
    const out = await client.create({
      repoId: "acme-dev",
      branch: "cv-1-fix",
      brief: "do the thing",
      flagsFileContent: '{"my-flag":true}',
    });
    expect(out).toEqual({ sandboxId: "sb-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://c/sandboxes");
    expect(calls[0]!.body).toEqual({
      repoId: "acme-dev",
      branch: "cv-1-fix",
      brief: "do the thing",
      flagsFileContent: '{"my-flag":true}',
    });
  });

  test("imageTag is omitted from the create body when not given", async () => {
    const { fetchFn, calls } = fakeFetch({
      "POST /sandboxes": { status: 200, json: { sandboxId: "sb-2" } },
    });
    await createSandboxClient("http://c", fetchFn).create({
      repoId: "r", branch: "b", brief: "x",
    });
    expect(Object.keys(calls[0]!.body as object)).toEqual(["repoId", "branch", "brief"]);
  });

  test("list GETs /sandboxes; get returns the detail and null on 404", async () => {
    const { fetchFn } = fakeFetch({
      "GET /sandboxes": { status: 200, json: [DETAIL] },
      "GET /sandboxes/sb-1": { status: 200, json: DETAIL },
      "GET /sandboxes/nope": { status: 404 },
    });
    const client = createSandboxClient("http://c", fetchFn);
    expect(await client.list()).toEqual([DETAIL]);
    expect(await client.get("sb-1")).toEqual(DETAIL);
    expect(await client.get("nope")).toBeNull();
  });

  test("suspend / up / destroy hit the spec verbs and throw on non-ok", async () => {
    const { fetchFn, calls } = fakeFetch({
      "POST /sandboxes/sb-1/suspend": { status: 200 },
      "POST /sandboxes/sb-1/up": { status: 200 },
      "DELETE /sandboxes/sb-1": { status: 200 },
    });
    const client = createSandboxClient("http://c", fetchFn);
    await client.suspend("sb-1");
    await client.up("sb-1");
    await client.destroy("sb-1");
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      "POST http://c/sandboxes/sb-1/suspend",
      "POST http://c/sandboxes/sb-1/up",
      "DELETE http://c/sandboxes/sb-1",
    ]);
    await expect(client.suspend("missing")).rejects.toThrow(/suspend/);
  });

  test("events pass ?since= and return the ordered typed events", async () => {
    const events: SandboxEvent[] = [
      { seq: 3, ts: "t", sandboxId: "sb-1", type: "question", payload: { file: "question.md" } },
    ];
    const { fetchFn, calls } = fakeFetch({
      "GET /sandboxes/sb-1/events?since=2": { status: 200, json: events },
    });
    const got = await createSandboxClient("http://c", fetchFn).events("sb-1", 2);
    expect(got).toEqual(events);
    expect(calls[0]!.url).toBe("http://c/sandboxes/sb-1/events?since=2");
  });

  test("mailbox GET lists files; POST delivers a named file", async () => {
    const { fetchFn, calls } = fakeFetch({
      "GET /sandboxes/sb-1/mailbox": { status: 200, json: [{ name: "answer.md", content: "yes" }] },
      "POST /sandboxes/sb-1/mailbox": { status: 200 },
    });
    const client = createSandboxClient("http://c", fetchFn);
    expect(await client.mailbox("sb-1")).toEqual([{ name: "answer.md", content: "yes" }]);
    await client.postMailbox("sb-1", { name: "answer.md", content: "yes" });
    expect(calls[1]!.body).toEqual({ name: "answer.md", content: "yes" });
  });
});

// ─── Overlay sandbox config ──────────────────────────────────────────────────

describe("readSandboxConfig", () => {
  test("reads the overlay's sandbox section; localPorts default to the pod port", () => {
    const root = mkdtempSync(join(tmpdir(), "sbx-overlay-"));
    mkdirSync(join(root, "acme-dev"), { recursive: true });
    writeFileSync(join(root, "acme-dev", "config.json"), JSON.stringify({
      sandbox: {
        processes: [
          { name: "adjuster", port: 4001, localPorts: [4001, 5001, 6001] },
          { name: "backend", port: 4000 },
        ],
        stateFile: "~/.acme/dev-ports.state.json",
        browserSecretsFile: "~/.acme/browser.env",
        agentCredentialFiles: { "claude-session.json": "~/.claude/session.json" },
      },
    }));
    process.env.HOME = "/tmp/sbx-home";
    const config = readSandboxConfig("acme-dev", root)!;
    expect(config.processes).toEqual([
      { name: "adjuster", port: 4001, localPorts: [4001, 5001, 6001] },
      { name: "backend", port: 4000, localPorts: [4000] },
    ]);
    expect(config.stateFile).toBe("/tmp/sbx-home/.acme/dev-ports.state.json");
    expect(config.browserSecretsFile).toBe("/tmp/sbx-home/.acme/browser.env");
    expect(config.agentCredentialFiles).toEqual({
      "claude-session.json": "/tmp/sbx-home/.claude/session.json",
    });
  });

  test("null when the overlay or its sandbox section is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "sbx-overlay-"));
    expect(readSandboxConfig("ghost", root)).toBeNull();
    mkdirSync(join(root, "plain"), { recursive: true });
    writeFileSync(join(root, "plain", "config.json"), JSON.stringify({ setup: [] }));
    expect(readSandboxConfig("plain", root)).toBeNull();
  });

  test("listSandboxOverlays finds exactly the repos with a sandbox section", () => {
    const root = mkdtempSync(join(tmpdir(), "sbx-overlay-"));
    for (const [repo, config] of [
      ["with-sandbox", { sandbox: { processes: [{ name: "app", port: 3000 }] } }],
      ["without", { setup: [] }],
    ] as const) {
      mkdirSync(join(root, repo), { recursive: true });
      writeFileSync(join(root, repo, "config.json"), JSON.stringify(config));
    }
    const overlays = listSandboxOverlays(root);
    expect(overlays.map(o => o.repoId)).toEqual(["with-sandbox"]);
    expect(overlays[0]!.config.processes[0]!.name).toBe("app");
  });
});

// ─── Anchor directory ────────────────────────────────────────────────────────

describe("sandbox anchors", () => {
  const ANCHOR: SandboxAnchor = {
    id: "sb-1",
    repoId: "acme-dev",
    branch: "cv-1-fix",
    createdAt: "2026-08-07T00:00:00.000Z",
    lastEventSeq: 0,
  };

  test("write → read round-trips sandbox.json under ~/.rt/sandboxes/<repoId>/<id>/", () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sbx-home-"));
    writeSandboxAnchor(ANCHOR);
    const path = join(process.env.HOME, ".rt", "sandboxes", "acme-dev", "sb-1", "sandbox.json");
    expect(existsSync(path)).toBe(true);
    expect(readSandboxAnchor("acme-dev", "sb-1")).toEqual(ANCHOR);
  });

  test("read returns null for a missing anchor; remove deletes the dir", () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sbx-home-"));
    expect(readSandboxAnchor("acme-dev", "ghost")).toBeNull();
    writeSandboxAnchor(ANCHOR);
    removeSandboxAnchor("acme-dev", "sb-1");
    expect(readSandboxAnchor("acme-dev", "sb-1")).toBeNull();
  });
});

// ─── Branch push (receiver handshake) ────────────────────────────────────────

describe("pushSandboxBranch", () => {
  test("pushes the commit to refs/sandboxes/incoming/<branch> with the receiver ssh env", async () => {
    const pushes: Array<{ argv: string[]; cwd: string; env: Record<string, string> }> = [];
    const out = await pushSandboxBranch({
      repoId: "acme-dev",
      branch: "cv-1-fix",
      commit: "abc123",
      cwd: "/work",
      spawn: async (argv, opts) => {
        pushes.push({ argv, cwd: opts.cwd, env: opts.env });
        return { exitCode: 0, stderr: "" };
      },
      env: { MC_RECEIVER_SSH_KEY: "/key" },
    });
    expect(out.ok).toBe(true);
    expect(sandboxIncomingRef("cv-1-fix")).toBe("refs/sandboxes/incoming/cv-1-fix");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.argv).toEqual([
      "git", "push", "ssh://git@localhost:2222/repos/acme-dev.git",
      "+abc123:refs/sandboxes/incoming/cv-1-fix",
    ]);
    expect(pushes[0]!.cwd).toBe("/work");
    expect(pushes[0]!.env.GIT_SSH_COMMAND).toContain("/key");
  });

  test("a failed push surfaces ok:false with stderr", async () => {
    const out = await pushSandboxBranch({
      repoId: "acme-dev",
      branch: "b",
      commit: "abc",
      cwd: "/work",
      spawn: async () => ({ exitCode: 1, stderr: "denied" }),
    });
    expect(out.ok).toBe(false);
    expect(out.stderr).toBe("denied");
  });
});

// ─── Flags ───────────────────────────────────────────────────────────────────

describe("flags", () => {
  test("parseFlagValues parses booleans, numbers, and strings", () => {
    expect(parseFlagValues(["a=true", "b=false", "n=3", "s=hello", "j={\"x\":1}"])).toEqual({
      a: true, b: false, n: 3, s: "hello", j: { x: 1 },
    });
  });

  test("parseFlagValues rejects malformed pairs", () => {
    expect(() => parseFlagValues(["nope"])).toThrow(/k=v/);
  });

  test("upsertFlagsSecret applies an in-memory Secret manifest via kubectl stdin", async () => {
    const { exec, calls } = fakeExec({
      "kubectl -n mc-sandboxes apply": { stdout: "secret/sandbox-sb-1-flags configured", exitCode: 0 },
    });
    const out = await upsertFlagsSecret({ sandboxId: "sb-1", flags: { "my-flag": true }, exec });
    expect(out.exitCode).toBe(0);
    expect(out.message).toContain("sandbox-sb-1-flags");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual(["kubectl", "-n", "mc-sandboxes", "apply", "-f", "-"]);
    const manifest = JSON.parse(calls[0]!.stdin!);
    expect(manifest.kind).toBe("Secret");
    expect(manifest.metadata).toEqual({ name: "sandbox-sb-1-flags", namespace: "mc-sandboxes" });
    expect(JSON.parse(manifest.stringData["flags.json"])).toEqual({ "my-flag": true });
  });

  test("upsertFlagsSecret maps kubectl failure to exit 1", async () => {
    const { exec } = fakeExec({ "kubectl": { stdout: "", exitCode: 1 } });
    const out = await upsertFlagsSecret({ sandboxId: "sb-1", flags: {}, exec });
    expect(out.exitCode).toBe(1);
    expect(out.message).toContain("kubectl");
  });
});

// ─── Create flow ─────────────────────────────────────────────────────────────

describe("createSandboxFlow", () => {
  function world(pushExit = 0) {
    const order: string[] = [];
    const client = {
      async create(req: unknown) {
        order.push("create");
        (world as unknown as Record<string, unknown>).lastCreateBody = req;
        return { sandboxId: "sb-9" };
      },
    } as unknown as import("../sandbox.ts").SandboxClient;
    const spawn = async (argv: string[]) => {
      order.push(`push ${argv[3]}`);
      return { exitCode: pushExit, stderr: pushExit === 0 ? "" : "denied" };
    };
    return { order, client, spawn };
  }

  test("pushes the handshake ref first, then POSTs, then writes the anchor", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sbx-home-"));
    const { order, client, spawn } = world();
    const out = await createSandboxFlow({
      repoId: "acme-dev", branch: "cv-9", commit: "abc", cwd: "/w",
      brief: "do it", flags: { f: true }, client, spawn,
    });
    expect(out).toEqual({ ok: true, sandboxId: "sb-9" });
    expect(order).toEqual(["push +abc:refs/sandboxes/incoming/cv-9", "create"]);
    const anchor = readSandboxAnchor("acme-dev", "sb-9")!;
    expect(anchor.branch).toBe("cv-9");
    expect(anchor.lastEventSeq).toBe(0);
  });

  test("flags serialize into flagsFileContent; omitted entirely when absent", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sbx-home-"));
    const bodies: Array<Record<string, unknown>> = [];
    const client = {
      async create(req: Record<string, unknown>) { bodies.push(req); return { sandboxId: "s" }; },
    } as unknown as import("../sandbox.ts").SandboxClient;
    const spawn = async () => ({ exitCode: 0, stderr: "" });
    await createSandboxFlow({ repoId: "r", branch: "b", commit: "c", cwd: "/w", brief: "x", flags: { f: 1 }, client, spawn });
    await createSandboxFlow({ repoId: "r", branch: "b", commit: "c", cwd: "/w", brief: "x", client, spawn });
    expect(JSON.parse(bodies[0]!.flagsFileContent as string)).toEqual({ f: 1 });
    expect("flagsFileContent" in bodies[1]!).toBe(false);
    expect("imageTag" in bodies[1]!).toBe(false);
  });

  test("a host-key push failure carries the one-line remedy in the message", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sbx-home-"));
    const client = {
      async create(): Promise<never> { throw new Error("must not POST after a failed push"); },
    } as unknown as import("../sandbox.ts").SandboxClient;
    const spawn = async () => ({
      exitCode: 128,
      stderr: "Host key verification failed.\nfatal: Could not read from remote repository.",
    });
    const out = await createSandboxFlow({
      repoId: "acme-dev", branch: "b", commit: "c", cwd: "/w", brief: "x", client, spawn,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toContain("ssh-keygen -R");
      expect(out.message).toContain("ssh-keyscan");
    }
  });

  test("a failed push short-circuits: no POST, no anchor", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sbx-home-"));
    const { order, client, spawn } = world(1);
    const out = await createSandboxFlow({
      repoId: "acme-dev", branch: "cv-9", commit: "abc", cwd: "/w", brief: "x", client, spawn,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("denied");
    expect(order).toHaveLength(1);
    expect(readSandboxAnchor("acme-dev", "sb-9")).toBeNull();
  });
});

// ─── Anchor lookup + logs argv ───────────────────────────────────────────────

describe("findSandboxAnchor", () => {
  test("finds an anchor across repoIds; null when unknown", () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sbx-home-"));
    writeSandboxAnchor({ id: "sb-1", repoId: "acme-dev", branch: "b", createdAt: "t", lastEventSeq: 0 });
    expect(findSandboxAnchor("sb-1")).toMatchObject({ id: "sb-1", repoId: "acme-dev" });
    expect(findSandboxAnchor("ghost")).toBeNull();
  });
});

describe("sandboxLogsArgv", () => {
  test("kubectl logs passthrough for the sandbox pod, extra args appended", () => {
    expect(sandboxLogsArgv("sb-1", "agent", ["-f"])).toEqual([
      "kubectl", "-n", "mc-sandboxes", "logs", "sb-1", "-c", "agent", "-f",
    ]);
  });
});
