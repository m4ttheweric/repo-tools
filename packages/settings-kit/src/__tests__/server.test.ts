import { beforeEach, describe, expect, test } from "bun:test";
import { settingsHandler, type RtSettingsApi, type SettingsHandlerOptions } from "../server.ts";

interface FakeDef {
  key: string;
  type: string;
  scopes: string[];
  merge: string;
  description: string;
  secret?: boolean;
  teamLocked?: boolean;
  repoScoped?: boolean;
  default?: unknown;
}

const DEFS: Record<string, FakeDef> = {
  "board.title": { key: "board.title", type: "string", scopes: ["user", "machine"], merge: "replace", description: "Board title", default: "Board" },
  "board.rtRepos": { key: "board.rtRepos", type: "array", scopes: ["machine"], merge: "replace", description: "Project map" },
  "rt.secretThing": { key: "rt.secretThing", type: "string", scopes: ["user"], merge: "replace", description: "A secret", secret: true },
  "rt.legacyThing": { key: "rt.legacyThing", type: "string", scopes: ["user"], merge: "replace", description: "Unmigrated" },
};

const setCalls: unknown[][] = [];

// Injected through opts.rt, never mock.module — bun's module mock mutates the
// shared registry and would poison rt-client's own tests later in the run.
const RT = {
  allDefs: () => Object.values(DEFS),
  getDef: (key: string) => DEFS[key],
  isMigrated: (def: FakeDef) => def.key !== "rt.legacyThing",
  explainSetting: (key: string) => [
    { scope: "user", file: "/home/user/settings.user.jsonc", present: true, value: `${key}-user-value` },
    { scope: "machine", file: "/home/user/local/settings.local.jsonc", present: false },
  ],
  validateValue: (_def: FakeDef, value: unknown) =>
    value === "invalid" ? { ok: false, reason: "value is invalid" } : { ok: true },
  setSetting: (...args: unknown[]) => {
    setCalls.push(args);
    if (args[0] === "board.title" && args[1] === "explode") throw new Error("rt: store refused the write");
  },
} as unknown as RtSettingsApi;

function handle(req: Request, extra: SettingsHandlerOptions = {}): Promise<Response | null> {
  return settingsHandler(req, { rt: RT, ...extra });
}

function get(path: string, host = "console.mattstack"): Request {
  return new Request(`http://${host}${path}`);
}

function post(path: string, body: unknown, host = "console.mattstack"): Request {
  return new Request(`http://${host}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  setCalls.length = 0;
});

describe("settingsHandler routing", () => {
  test("returns null for non-settings routes so the host falls through", async () => {
    expect(await handle(get("/api/runs"))).toBeNull();
    expect(await handle(get("/"))).toBeNull();
  });

  test("defs lists every registered def with the writable flag computed", async () => {
    const res = await handle(get("/api/settings/defs"));
    const body = (await res!.json()) as { defs: Array<{ key: string; writable: boolean }> };
    const byKey = Object.fromEntries(body.defs.map((d) => [d.key, d]));
    expect(byKey["board.title"]!.writable).toBe(true);
    expect(byKey["board.rtRepos"]!.writable).toBe(false); // composite
    expect(byKey["rt.secretThing"]!.writable).toBe(false); // secret
    expect(byKey["rt.legacyThing"]!.writable).toBe(false); // unmigrated
  });

  test("defs?prefix= filters to one app's namespace", async () => {
    const res = await handle(get("/api/settings/defs?prefix=board."));
    const body = (await res!.json()) as { defs: Array<{ key: string }> };
    expect(body.defs.map((d) => d.key).sort()).toEqual(["board.rtRepos", "board.title"]);
  });

  test("a custom basePath relocates every route", async () => {
    const res = await handle(get("/settings-kit/defs"), { basePath: "/settings-kit" });
    expect(res).not.toBeNull();
    expect(await handle(get("/api/settings/defs"), { basePath: "/settings-kit" })).toBeNull();
  });
});

describe("explain", () => {
  test("returns def + rows for a known key", async () => {
    const res = await handle(get("/api/settings/explain/board.title"));
    const body = (await res!.json()) as { def: { key: string }; rows: Array<{ value?: unknown }> };
    expect(body.def.key).toBe("board.title");
    expect(body.rows[0]!.value).toBe("board.title-user-value");
  });

  test("404s an unknown key", async () => {
    const res = await handle(get("/api/settings/explain/nope.nothing"));
    expect(res!.status).toBe(404);
  });

  test("a secret key's rows carry presence but never values", async () => {
    const res = await handle(get("/api/settings/explain/rt.secretThing"));
    const body = (await res!.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows[0]!.present).toBe(true);
    expect("value" in body.rows[0]!).toBe(false);
  });
});

describe("set guard ladder", () => {
  test("writes a valid staged value and returns fresh rows", async () => {
    const res = await handle(post("/api/settings/set", { key: "board.title", value: "My Board", scope: "user" }));
    expect(res!.status).toBe(200);
    expect(setCalls).toEqual([["board.title", "My Board", "user", {}]]);
    const body = (await res!.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(2);
  });

  test.each([
    ["unknown key → 404", { key: "nope", value: 1, scope: "user" }, 404],
    ["secret → 400", { key: "rt.secretThing", value: "x", scope: "user" }, 400],
    ["composite → 400", { key: "board.rtRepos", value: [], scope: "machine" }, 400],
    ["scope not allowed → 400", { key: "board.title", value: "x", scope: "team" }, 400],
    ["unmigrated → 400", { key: "rt.legacyThing", value: "x", scope: "user" }, 400],
    ["invalid value → 400", { key: "board.title", value: "invalid", scope: "user" }, 400],
  ])("%s", async (_label, body, status) => {
    const res = await handle(post("/api/settings/set", body));
    expect(res!.status).toBe(status);
    expect(setCalls).toHaveLength(0);
  });

  test("a setSetting refusal answers 400 with rt's own message", async () => {
    const res = await handle(post("/api/settings/set", { key: "board.title", value: "explode", scope: "user" }));
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toContain("rt: store refused");
  });
});

describe("write gate", () => {
  test("default gate refuses a non-local Host", async () => {
    const res = await handle(post("/api/settings/set", { key: "board.title", value: "x", scope: "user" }, "board.example.com"));
    expect(res!.status).toBe(403);
    expect(setCalls).toHaveLength(0);
  });

  test("default gate admits localhost and *.mattstack; reads are never gated", async () => {
    for (const host of ["localhost:3000", "127.0.0.1:11006", "board.mattstack"]) {
      const res = await handle(post("/api/settings/set", { key: "board.title", value: "x", scope: "user" }, host));
      expect(res!.status).toBe(200);
    }
    const read = await handle(get("/api/settings/defs", "board.example.com"));
    expect(read!.status).toBe(200);
  });

  test("a host-supplied allowWrite replaces the default entirely", async () => {
    const res = await handle(post("/api/settings/set", { key: "board.title", value: "x", scope: "user" }), { allowWrite: () => false });
    expect(res!.status).toBe(403);
  });
});
