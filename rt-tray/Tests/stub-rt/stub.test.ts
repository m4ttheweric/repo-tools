import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB = join(import.meta.dir, "stub.ts");

async function run(scenario: string, args: string[], stdin = "", stateDir?: string) {
  const proc = Bun.spawn(["bun", STUB, ...args], {
    env: { ...process.env, RT_STUB_SCENARIO: scenario, RT_STUB_STATE_DIR: stateDir ?? mkdtempSync(join(tmpdir(), "stub-")) },
    stdin: new Blob([stdin]),
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out, lines: out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

test("setup plan: join-happy is installable, perm-denied is not", async () => {
  const ok = await run("join-happy", ["setup", "plan", "--json"]);
  expect(ok.code).toBe(0);
  expect(ok.lines[0].contract).toBe(1);
  expect(ok.lines[0].canInstall).toBe(true);
  const denied = await run("perm-denied-then-granted", ["setup", "plan", "--json"]);
  expect(denied.lines[0].canInstall).toBe(false);
  expect(denied.lines[0].requiredMissing).toContain("perm.fda");
});

test("perm-denied-then-granted: plan flips to installable on the second call", async () => {
  const state = mkdtempSync(join(tmpdir(), "stub-"));
  const first = await run("perm-denied-then-granted", ["setup", "plan", "--json"], "", state);
  const second = await run("perm-denied-then-granted", ["setup", "plan", "--json"], "", state);
  expect(first.lines[0].canInstall).toBe(false);
  expect(second.lines[0].canInstall).toBe(true);
});

test("team join --dry-run reads the code from stdin; no-access is exit 0 {access:'denied'} with a specific message", async () => {
  const happy = await run("join-happy", ["team", "join", "--dry-run", "--json"], JSON.stringify({ code: "ABCD-EFGH" }));
  expect(happy.code).toBe(0);
  expect(happy.lines[0].access).toBe("ok");
  expect(happy.lines[0].team.name).toBe("Acme");
  const denied = await run("join-no-access", ["team", "join", "--dry-run", "--json"], JSON.stringify({ code: "ABCD-EFGH" }));
  expect(denied.code).toBe(0);
  expect(denied.lines[0].access).toBe("denied");
  expect(denied.lines[0].message).toContain("ask");
  const malformed = await run("join-happy", ["team", "join", "--dry-run", "--json"], JSON.stringify({ code: "" }));
  expect(malformed.code).toBe(2);
  expect(malformed.lines[0].error.code).toBe("invite-malformed");
});

test("setup apply streams plan/step/need/done; apply-fail-retry fails once then succeeds with --from", async () => {
  const state = mkdtempSync(join(tmpdir(), "stub-"));
  const first = await run("apply-fail-retry", ["setup", "apply", "--json"], "", state);
  const events = first.lines.map((e) => e.event);
  expect(events[0]).toBe("plan");
  expect(events).toContain("need");
  const done = first.lines.at(-1);
  expect(done.event).toBe("done");
  expect(done.ok).toBe(false);
  expect(done.failedStep).toBe("plugins.install");
  const retry = await run("apply-fail-retry", ["setup", "apply", "--from", "plugins.install", "--json"], "", state);
  expect(retry.lines[0].steps[0].id).toBe("plugins.install");
  expect(retry.lines.at(-1).ok).toBe(true);
});

test("uninstall --dry-run lists L1's action ids; --delete-data needs --yes; version build is numeric", async () => {
  const dry = await run("uninstall", ["uninstall", "--dry-run", "--json"]);
  expect(dry.lines[0].actions.map((a: { id: string }) => a.id)).toEqual(["services.unregister", "deck.managed-remove", "proxy.remove", "path.unlink", "shell.remove", "extension.uninstall", "plugins.uninstall", "app.trash"]);
  const dryDelete = await run("uninstall", ["uninstall", "--dry-run", "--delete-data", "--json"]);
  expect(dryDelete.lines[0].actions.map((a: { id: string }) => a.id)).toContain("data");
  const noYes = await run("uninstall", ["uninstall", "--delete-data", "--json"]);
  expect(noYes.code).toBe(2);
  expect(noYes.lines[0].error.code).toBe("confirm-required");
  const v = await run("join-happy", ["version", "--json"]);
  expect(v.lines[0].version).toBeDefined();
  expect(v.lines[0].build).toBe(0);
});

test("team status and setup github status answer the contract shapes", async () => {
  const ts = await run("join-happy", ["team", "status", "--json"]);
  expect(ts.lines[0].slug).toBe("acme");
  expect(ts.lines[0].members[0].username).toBe("matt");
  const gh = await run("join-happy", ["setup", "github", "status", "--json"]);
  expect(gh.lines[0].handle).toBe("matt");
  expect(gh.lines[0].owners).toContain("acme");
});

test("team create answers the contract's flat shape, not nested under team", async () => {
  const created = await run("join-happy", ["team", "create", "My Team", "--json"]);
  expect(created.code).toBe(0);
  expect(created.lines[0]).toMatchObject({ contract: 1, slug: "my-team", name: "My Team", created: true });
  expect(typeof created.lines[0].remote).toBe("string");
  expect((created.lines[0] as Record<string, unknown>).team).toBeUndefined();
});

test("uninstall real run's done event matches apply's shape with failedStep: null", async () => {
  const real = await run("uninstall", ["uninstall", "--json"]);
  expect(real.code).toBe(0);
  const done = real.lines.at(-1);
  expect(done.event).toBe("done");
  expect(done.ok).toBe(true);
  expect(done.failedStep).toBeNull();
});

test("restore scenario's apply stream starts at home.restore", async () => {
  const first = await run("restore", ["setup", "apply", "--json"]);
  expect(first.lines[0].event).toBe("plan");
  expect(first.lines[0].steps[0].id).toBe("home.restore");
  expect(first.lines[1].event).toBe("step");
  expect(first.lines[1].id).toBe("home.restore");
});
