import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attendedSshKeyPath,
  createSandboxClient,
  createSandboxFlow,
  ensureAttendedSshKey,
  findSandboxAnchor,
  listSandboxOverlays,
  parseEvidenceBeforeSpecs,
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
  body?: unknown;
  headers?: Record<string, string>;
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
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
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

  test("requestEvidence POSTs the body and returns requestId", async () => {
    const calls: any[] = [];
    const client = createSandboxClient("http://c", (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ requestId: "r1" }), { status: 200 });
    }) as unknown as typeof fetch);
    const out = await client.requestEvidence("sb1", {
      caseId: "c1", view: "v", recipe: "r", slot: "after", args: { contactId: "k" },
    });
    expect(out).toEqual({ requestId: "r1" });
    expect(calls[0].url).toBe("http://c/sandboxes/sb1/evidence");
    expect(JSON.parse(calls[0].init.body)).toEqual({
      caseId: "c1", view: "v", recipe: "r", slot: "after", args: { contactId: "k" },
    });
  });

  test("getEvidence maps 404 to null; fetchEvidenceArtifact returns raw bytes", async () => {
    const client404 = createSandboxClient("http://c", (async () => new Response("nf", { status: 404 })) as unknown as typeof fetch);
    expect(await client404.getEvidence("nope")).toBeNull();
    const bytes = new Uint8Array([1, 2, 3]);
    const clientBytes = createSandboxClient("http://c", (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch);
    expect(await clientBytes.fetchEvidenceArtifact("r1", "base.png")).toEqual(bytes);
  });

  test("listEvidence adds ?state= only when given; cancel/ack throw on non-2xx", async () => {
    const urls: string[] = [];
    const ok = createSandboxClient("http://c", (async (url: string | URL) => {
      urls.push(String(url));
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch);
    await ok.listEvidence("sb1");
    await ok.listEvidence("sb1", "queued");
    expect(urls).toEqual(["http://c/sandboxes/sb1/evidence", "http://c/sandboxes/sb1/evidence?state=queued"]);
    const bad = createSandboxClient("http://c", (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch);
    await expect(bad.cancelEvidence("r1")).rejects.toThrow("controller");
    await expect(bad.ackEvidenceSynced("r1")).rejects.toThrow("controller");
  });
});

describe("bearer header", () => {
  const prev = process.env.MC_API_TOKEN;
  afterEach(() => {
    if (prev === undefined) delete process.env.MC_API_TOKEN;
    else process.env.MC_API_TOKEN = prev;
  });

  test("MC_API_TOKEN set: every call carries the bearer", async () => {
    process.env.MC_API_TOKEN = "s3cret";
    const { fetchFn, calls } = fakeFetch({ "POST /sandboxes/sb-1/mailbox": { status: 200 } });
    const client = createSandboxClient("http://c", fetchFn);
    await client.postMailbox("sb-1", { name: "answer.md", content: "x" });
    expect(calls[0]!.headers!["authorization"]).toBe("Bearer s3cret");
  });

  test("MC_API_TOKEN unset: no auth header", async () => {
    delete process.env.MC_API_TOKEN;
    const { fetchFn, calls } = fakeFetch({ "POST /sandboxes/sb-1/mailbox": { status: 200 } });
    const client = createSandboxClient("http://c", fetchFn);
    await client.postMailbox("sb-1", { name: "answer.md", content: "x" });
    expect(calls[0]!.headers?.["authorization"]).toBeUndefined();
  });
});

// ─── Overlay sandbox config ──────────────────────────────────────────────────

describe("readSandboxConfig", () => {
  test("reads the overlay's sandbox.jsonc (comments allowed); localPorts default to the pod port", () => {
    const root = mkdtempSync(join(tmpdir(), "sbx-overlay-"));
    mkdirSync(join(root, "acme-dev"), { recursive: true });
    writeFileSync(join(root, "acme-dev", "sandbox.jsonc"), `// adapter facts
${JSON.stringify({
      processes: [
        { name: "adjuster", port: 4001, localPorts: [4001, 5001, 6001] },
        { name: "backend", port: 4000 },
      ],
      stateFile: "~/.acme/dev-ports.state.json",
      browserSecretsFile: "~/.acme/browser.env",
      agentCredentialFiles: { "claude-session.json": "~/.claude/session.json" },
    })}`);
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

  test("null when sandbox.jsonc is missing or malformed; the config.json path is dead", () => {
    const root = mkdtempSync(join(tmpdir(), "sbx-overlay-"));
    expect(readSandboxConfig("ghost", root)).toBeNull();
    mkdirSync(join(root, "plain"), { recursive: true });
    writeFileSync(join(root, "plain", "sandbox.jsonc"), "{ not json");
    expect(readSandboxConfig("plain", root)).toBeNull();
    // A config.json sandbox section no longer counts (ruled: no fallback).
    mkdirSync(join(root, "legacy"), { recursive: true });
    writeFileSync(join(root, "legacy", "config.json"), JSON.stringify({
      sandbox: { processes: [{ name: "app", port: 3000 }] },
    }));
    expect(readSandboxConfig("legacy", root)).toBeNull();
  });

  test("listSandboxOverlays finds exactly the repos with a sandbox.jsonc", () => {
    const root = mkdtempSync(join(tmpdir(), "sbx-overlay-"));
    mkdirSync(join(root, "with-sandbox"), { recursive: true });
    writeFileSync(join(root, "with-sandbox", "sandbox.jsonc"), JSON.stringify({
      processes: [{ name: "app", port: 3000 }],
    }));
    mkdirSync(join(root, "without"), { recursive: true });
    writeFileSync(join(root, "without", "config.json"), JSON.stringify({ setup: [] }));
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
      "git", "push", "ssh://git@127.0.0.1:2222/repos/acme-dev.git",
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

// ─── Evidence-before specs ───────────────────────────────────────────────────

describe("parseEvidenceBeforeSpecs", () => {
  test("parses specs with and without an args segment", () => {
    expect(parseEvidenceBeforeSpecs([
      "c1:cvi-case:shot",
      "c2:cvi-case:shot:contactId=k,section=overview",
    ])).toEqual([
      { caseId: "c1", view: "cvi-case", recipe: "shot" },
      { caseId: "c2", view: "cvi-case", recipe: "shot", args: { contactId: "k", section: "overview" } },
    ]);
  });

  test("colons after the third belong to the args segment (values may carry them)", () => {
    expect(parseEvidenceBeforeSpecs(["c1:v:r:url=http://x:8080"])).toEqual([
      { caseId: "c1", view: "v", recipe: "r", args: { url: "http://x:8080" } },
    ]);
  });

  test("malformed specs throw with the expected form named", () => {
    for (const bad of [
      "c1:v",              // too few segments
      "c1::r",             // empty segment
      "c1:v:r:",           // empty args segment
      "c1:v:r:noequals",   // args pair without =
      "c1:v:r:=v",         // empty args key
    ]) {
      expect(() => parseEvidenceBeforeSpecs([bad])).toThrow("<caseId>:<view>:<recipe>[:k=v,...]");
    }
  });

  test("rejects more than 10 entries (controller cap)", () => {
    const specs = Array.from({ length: 11 }, (_, i) => `c${i}:v:r`);
    expect(() => parseEvidenceBeforeSpecs(specs)).toThrow("at most 10");
    expect(parseEvidenceBeforeSpecs(specs.slice(0, 10))).toHaveLength(10);
  });
});

// ─── Create flow ─────────────────────────────────────────────────────────────

describe("createSandboxFlow", () => {
  /** Exec fake resolving only the given refs; records every rev-parse. */
  function gitRefs(refs: Record<string, string>) {
    const resolved: string[] = [];
    const exec: Exec = async (argv) => {
      const ref = argv[argv.length - 1]!;
      resolved.push(ref);
      const commit = refs[ref];
      return commit ? { stdout: `${commit}\n`, exitCode: 0 } : { stdout: "", exitCode: 1 };
    };
    return { exec, resolved };
  }

  function world(pushExit = 0, refs: Record<string, string> = { "refs/heads/cv-9": "abc" }) {
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
    return { order, client, spawn, ...gitRefs(refs) };
  }

  test("resolves refs/heads/<branch>, pushes the handshake ref, POSTs, writes the anchor", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sbx-home-"));
    const { order, client, spawn, exec, resolved } = world();
    const out = await createSandboxFlow({
      repoId: "acme-dev", branch: "cv-9", cwd: "/w",
      brief: "do it", flags: { f: true }, client, spawn, exec,
    });
    expect(out).toEqual({ ok: true, sandboxId: "sb-9" });
    expect(resolved).toEqual(["refs/heads/cv-9"]);
    expect(order).toEqual(["push +abc:refs/sandboxes/incoming/cv-9", "create"]);
    const anchor = readSandboxAnchor("acme-dev", "sb-9")!;
    expect(anchor.branch).toBe("cv-9");
    expect(anchor.lastEventSeq).toBe(0);
  });

  test("a branch that does not resolve aborts: no push, no POST, no anchor", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sbx-home-"));
    const { order, client, spawn, exec } = world(0, {});
    const out = await createSandboxFlow({
      repoId: "acme-dev", branch: "cv-ghost", cwd: "/w", brief: "x", client, spawn, exec,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toContain('branch "cv-ghost"');
      expect(out.message).toContain("refs/heads/cv-ghost");
    }
    expect(order).toEqual([]);
    expect(readSandboxAnchor("acme-dev", "sb-9")).toBeNull();
  });

  test("fallbackRef seeds a missing branch from the base ref (the --ticket path)", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sbx-home-"));
    const { order, client, spawn, exec, resolved } = world(0, { "refs/remotes/origin/master": "base1" });
    const out = await createSandboxFlow({
      repoId: "acme-dev", branch: "cv-9", cwd: "/w", brief: "x",
      fallbackRef: "refs/remotes/origin/master", client, spawn, exec,
    });
    expect(out).toEqual({ ok: true, sandboxId: "sb-9" });
    expect(resolved).toEqual(["refs/heads/cv-9", "refs/remotes/origin/master"]);
    expect(order[0]).toBe("push +base1:refs/sandboxes/incoming/cv-9");
  });

  test("fallbackRef that does not resolve either still aborts, naming both refs", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sbx-home-"));
    const { order, client, spawn, exec } = world(0, {});
    const out = await createSandboxFlow({
      repoId: "acme-dev", branch: "cv-9", cwd: "/w", brief: "x",
      fallbackRef: "refs/remotes/origin/master", client, spawn, exec,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("refs/remotes/origin/master");
    expect(order).toEqual([]);
  });

  test("flags serialize into flagsFileContent; omitted entirely when absent", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sbx-home-"));
    const bodies: Array<Record<string, unknown>> = [];
    const client = {
      async create(req: Record<string, unknown>) { bodies.push(req); return { sandboxId: "s" }; },
    } as unknown as import("../sandbox.ts").SandboxClient;
    const spawn = async () => ({ exitCode: 0, stderr: "" });
    const { exec } = gitRefs({ "refs/heads/b": "c" });
    await createSandboxFlow({ repoId: "r", branch: "b", cwd: "/w", brief: "x", flags: { f: 1 }, client, spawn, exec });
    await createSandboxFlow({ repoId: "r", branch: "b", cwd: "/w", brief: "x", client, spawn, exec });
    expect(JSON.parse(bodies[0]!.flagsFileContent as string)).toEqual({ f: 1 });
    expect("flagsFileContent" in bodies[1]!).toBe(false);
    expect("imageTag" in bodies[1]!).toBe(false);
  });

  test("evidenceBefore passes through to the create body; omitted when absent", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sbx-home-"));
    const bodies: Array<Record<string, unknown>> = [];
    const client = {
      async create(req: Record<string, unknown>) { bodies.push(req); return { sandboxId: "s" }; },
    } as unknown as import("../sandbox.ts").SandboxClient;
    const spawn = async () => ({ exitCode: 0, stderr: "" });
    const { exec } = gitRefs({ "refs/heads/b": "c" });
    const evidenceBefore = [
      { caseId: "c1", view: "cvi-case", recipe: "shot", args: { contactId: "k" } },
      { caseId: "c2", view: "cvi-case", recipe: "shot" },
    ];
    await createSandboxFlow({ repoId: "r", branch: "b", cwd: "/w", brief: "x", evidenceBefore, client, spawn, exec });
    await createSandboxFlow({ repoId: "r", branch: "b", cwd: "/w", brief: "x", client, spawn, exec });
    expect(bodies[0]!.evidenceBefore).toEqual(evidenceBefore);
    expect("evidenceBefore" in bodies[1]!).toBe(false);
  });

  test("agentCredentialKey/agentEnv pass through to the create body; omitted when absent", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sbx-home-"));
    const bodies: Array<Record<string, unknown>> = [];
    const client = {
      async create(req: Record<string, unknown>) { bodies.push(req); return { sandboxId: "s" }; },
    } as unknown as import("../sandbox.ts").SandboxClient;
    const spawn = async () => ({ exitCode: 0, stderr: "" });
    const { exec } = gitRefs({ "refs/heads/b": "c" });
    await createSandboxFlow({
      repoId: "r", branch: "b", cwd: "/w", brief: "x",
      agentCredentialKey: "acct-3.token",
      agentEnv: { ANTHROPIC_MODEL: "claude-sonnet-5" },
      client, spawn, exec,
    });
    await createSandboxFlow({ repoId: "r", branch: "b", cwd: "/w", brief: "x", client, spawn, exec });
    expect(bodies[0]!.agentCredentialKey).toBe("acct-3.token");
    expect(bodies[0]!.agentEnv).toEqual({ ANTHROPIC_MODEL: "claude-sonnet-5" });
    expect(Object.keys(bodies[1]!)).toEqual(["repoId", "branch", "brief"]);
  });

  test("attended/tuiCredentialKey pass through to the create body; omitted when absent (MAT-235)", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sbx-home-"));
    const bodies: Array<Record<string, unknown>> = [];
    const client = {
      async create(req: Record<string, unknown>) { bodies.push(req); return { sandboxId: "s" }; },
    } as unknown as import("../sandbox.ts").SandboxClient;
    const spawn = async () => ({ exitCode: 0, stderr: "" });
    const { exec } = gitRefs({ "refs/heads/b": "c" });
    await createSandboxFlow({
      repoId: "r", branch: "b", cwd: "/w", brief: "x",
      attended: true, tuiCredentialKey: "acct-3",
      client, spawn, exec,
    });
    await createSandboxFlow({ repoId: "r", branch: "b", cwd: "/w", brief: "x", client, spawn, exec });
    expect(bodies[0]!.attended).toBe(true);
    expect(bodies[0]!.tuiCredentialKey).toBe("acct-3");
    expect(Object.keys(bodies[1]!)).toEqual(["repoId", "branch", "brief"]);
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
    const { exec } = gitRefs({ "refs/heads/b": "c" });
    const out = await createSandboxFlow({
      repoId: "acme-dev", branch: "b", cwd: "/w", brief: "x", client, spawn, exec,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toContain("ssh-keygen -R");
      expect(out.message).toContain("ssh-keyscan");
    }
  });

  test("a failed push short-circuits: no POST, no anchor", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "sbx-home-"));
    const { order, client, spawn, exec } = world(1);
    const out = await createSandboxFlow({
      repoId: "acme-dev", branch: "cv-9", cwd: "/w", brief: "x", client, spawn, exec,
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

// ─── Attended ssh key (MAT-235) ──────────────────────────────────────────────

describe("ensureAttendedSshKey", () => {
  test("mints an ed25519 keypair on first need: 0700 dir, 0600 private half, pub returned", async () => {
    const home = mkdtempSync(join(tmpdir(), "sbx-sshkey-"));
    process.env.HOME = home;
    const keyPath = attendedSshKeyPath();
    expect(keyPath).toBe(join(home, ".rt", "secrets", "attended-ssh-key"));

    const argvs: string[][] = [];
    // The fake keygen writes both halves like the real one would.
    const exec: Exec = async (argv) => {
      argvs.push([...argv]);
      writeFileSync(keyPath, "PRIVATE", { mode: 0o644 });
      writeFileSync(`${keyPath}.pub`, "ssh-ed25519 AAAA rt-attended\n");
      return { stdout: "", exitCode: 0 };
    };
    const out = await ensureAttendedSshKey({ exec });

    expect(out).toEqual({ ok: true, created: true, publicKey: "ssh-ed25519 AAAA rt-attended" });
    expect(argvs).toHaveLength(1);
    expect(argvs[0]).toEqual(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "rt-attended-ssh-key", "-f", keyPath]);
    const { statSync } = await import("node:fs");
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".rt", "secrets")).mode & 0o777).toBe(0o700);
  });

  test("an existing key is reused without running ssh-keygen", async () => {
    const home = mkdtempSync(join(tmpdir(), "sbx-sshkey-"));
    process.env.HOME = home;
    mkdirSync(join(home, ".rt", "secrets"), { recursive: true });
    writeFileSync(attendedSshKeyPath(), "PRIVATE");
    writeFileSync(`${attendedSshKeyPath()}.pub`, "ssh-ed25519 BBBB rt-attended\n");
    const exec: Exec = async () => { throw new Error("ssh-keygen must not run"); };
    const out = await ensureAttendedSshKey({ exec });
    expect(out).toEqual({ ok: true, created: false, publicKey: "ssh-ed25519 BBBB rt-attended" });
  });

  test("a failed ssh-keygen surfaces as ok:false with the path named", async () => {
    const home = mkdtempSync(join(tmpdir(), "sbx-sshkey-"));
    process.env.HOME = home;
    const exec: Exec = async () => ({ stdout: "", exitCode: 1 });
    const out = await ensureAttendedSshKey({ exec });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("attended-ssh-key");
  });

  test("a private half without its pub half is an error, not a silent remint", async () => {
    const home = mkdtempSync(join(tmpdir(), "sbx-sshkey-"));
    process.env.HOME = home;
    mkdirSync(join(home, ".rt", "secrets"), { recursive: true });
    writeFileSync(attendedSshKeyPath(), "PRIVATE");
    const exec: Exec = async () => { throw new Error("ssh-keygen must not run"); };
    const out = await ensureAttendedSshKey({ exec });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("ssh-keygen -y");
  });
});
