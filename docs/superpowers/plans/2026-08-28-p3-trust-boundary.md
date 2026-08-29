# Phase 3 — The 127.0.0.1 Trust Boundary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the daemon's `:9401` trust boundary — WS/CORS origin auth, token-gate the ungated mutating/destructive routes, one shared api-token loader, input hygiene (body-size cap, path-param decode safety, query coercion) — plus the two standalone items S043 (EADDRINUSE diagnostics + typed failure) and S083 (`pathParam()` 400s).

**Architecture:** All logic lands as small, pure, dependency-injected functions in `lib/daemon/api-auth.ts` and `lib/daemon/api-server.ts` (mirroring the existing `bindApiServerWithRetry`/`needsToken`/`tokenOk` style already in this codebase) so every gate is unit-testable without spinning a real socket. The one exception is the request-body-size cap, which is a Bun.serve runtime option — that gets one small live `Bun.serve({port:0})` integration test. Two findings (S010, S050) have their fix location in sibling-owned files (`lib/daemon/handlers/worktree.ts`, `lib/daemon/freshness.ts`); this plan creates standalone, tested validator/utility modules for them and documents the one-line call-site wiring for the owning job, per the job brief's explicit instruction for S010 (mirrored here for S050 since its fix location is equally out of this job's write fence).

**Tech Stack:** Bun, TypeScript, `bun:test`, existing `@mattstack/rt-client` settings resolver.

**Spec:** `/Users/matt/Documents/GitHub/repo-tools/.claude/worktrees/daemon-stability-audit/docs/daemon-stability-audit-2026-08.md` — "Roadmap > Phase 3" (lines 72-79) plus Appendix A findings S005, S006, S010, S040, S041, S042, S043, S050, S054, S083, S084, S085, S092 (read-only input; never modify).

## Global Constraints

- Write fence: only `lib/daemon/api-server.ts`, `lib/daemon/api-auth.ts`, `lib/daemon/socket-server.ts`, `lib/daemon/handlers/secrets.ts`, new files under `lib/daemon/` (+ their tests under `lib/daemon/__tests__/`), `e2e/tests/`, `packages/rt-client/src/` (only if the client must send a token), the settings registry file, and `docs/`. Never touch `lib/daemon/handlers/worktree.ts`, `lib/daemon/freshness.ts`, or `lib/daemon.ts` — those are sibling-owned.
- Never start a daemon or run `rt`/`dist/rt` against the real machine; any such invocation in a test must run under `env -i HOME=<temp dir>`.
- `bun test lib commands packages scripts` must stay green; `bunx tsc --noEmit` must report zero errors.
- If `packages/rt-client` is touched, run `bun run build` inside it before the final review (dist-freshness test enforces this).
- Non-browser clients (no `Origin` header: the Swift tray, rt-client from Bun processes, mr-board, gitq, the VS Code extension) must keep working completely unchanged. A browser `Origin` must present the `X-RT-Token` (or, for `/ws`, a `?token=` query param) OR match the new `rt.trustedBrowserOrigins` settings allowlist.
- Never use em dashes or en dashes in code comments, commit messages, or docs (project convention — use parens or "...").
- Follow TDD: write the failing test first, watch it fail, then implement.

---

## File Map

| File | Change |
|---|---|
| `lib/daemon/request-limits.ts` | **new** — shared `MAX_REQUEST_BODY_SIZE` constant (S092) |
| `lib/daemon/api-auth.ts` | token singleton + warn (S054); settings-backed origin allowlist + `isBrowserRequestTrusted` (S005/S006); `needsToken` invert-default (S040/S041/S084) |
| `lib/daemon/api-server.ts` | CORS default-deny + `/ws` gate (S005/S006); `broadcastToClients` backpressure/dead-client handling (S042); `pathParam()` + 400 (S083); `coerceQueryParams` (S085); `ApiPortInUseError` + lsof probe (S043) |
| `lib/daemon/socket-server.ts` | wire `MAX_REQUEST_BODY_SIZE` (S092) |
| `lib/daemon/handlers/secrets.ts` | use the shared token singleton (S054) |
| `packages/rt-client/src/settings/registry-defs.ts` | new `rt.trustedBrowserOrigins` key |
| `lib/daemon/git-ref-validation.ts` | **new** — S010 validator (standalone; sibling wires into `worktree.ts`) |
| `lib/daemon/redact-credentials.ts` | **new** — S050 utility (standalone; sibling wires into `freshness.ts`) |
| `docs/daemon-api-auth.md` | **new** — short note on the auth model + the two wiring pointers |

All new tests live under `lib/daemon/__tests__/`.

---

## Task 1: Shared request body-size cap (S092)

**Files:**
- Create: `lib/daemon/request-limits.ts`
- Modify: `lib/daemon/api-server.ts` (add `maxRequestBodySize` to the `Bun.serve` options)
- Modify: `lib/daemon/socket-server.ts` (add `maxRequestBodySize` to the `Bun.serve` options)
- Test: `lib/daemon/__tests__/request-body-size.test.ts`

**Interfaces:**
- Produces: `export const MAX_REQUEST_BODY_SIZE: number` (1 MiB) from `lib/daemon/request-limits.ts`, imported by both servers.

- [ ] **Step 1: Write the failing test**

```ts
// lib/daemon/__tests__/request-body-size.test.ts
/**
 * Bun enforces `maxRequestBodySize` itself (413 before the handler runs) --
 * this is a live-server test, not a pure-function one, because there is no
 * pure function to unit test: the cap is a Bun.serve runtime option.
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { Server } from "bun";
import { MAX_REQUEST_BODY_SIZE } from "../request-limits.ts";

let server: Server<any> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("MAX_REQUEST_BODY_SIZE", () => {
  test("is set to 1 MiB", () => {
    expect(MAX_REQUEST_BODY_SIZE).toBe(1024 * 1024);
  });

  test("Bun rejects a body over the cap with a 4xx before the handler runs", async () => {
    let handlerRan = false;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      maxRequestBodySize: 10, // tiny cap for a fast, deterministic test
      async fetch(req) {
        handlerRan = true;
        await req.text();
        return new Response("ok");
      },
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
      body: "x".repeat(1000),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(handlerRan).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/daemon/__tests__/request-body-size.test.ts`
Expected: FAIL — `request-limits.ts` does not exist yet (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/daemon/request-limits.ts
/**
 * Shared cap on request body size for both daemon servers (api-server.ts's
 * :9401 HTTP/WS surface and socket-server.ts's unix-socket IPC channel).
 * Neither transport authenticates reads, so an unbounded body (Bun's
 * default is 128 MB) lets any same-user process or a cross-origin browser
 * request stall the daemon's single event loop parsing a giant payload.
 * Real payloads on both transports are kilobytes; 1 MiB costs nothing and
 * turns an oversized request into an immediate 413 instead.
 */
export const MAX_REQUEST_BODY_SIZE = 1024 * 1024;
```

Then in `lib/daemon/api-server.ts`, add the import and option:

```ts
import { MAX_REQUEST_BODY_SIZE } from "./request-limits.ts";
```

...and inside the `Bun.serve<ApiWSData, never>({ ... })` options object passed to `bindApiServerWithRetry`, add:

```ts
    maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
```

(alongside the existing `port`, `hostname`, `idleTimeout` keys).

In `lib/daemon/socket-server.ts`, add the same import and, inside the `Bun.serve({ ... })` call, add:

```ts
    maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/daemon/__tests__/request-body-size.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full daemon test slice for a quick regression check**

Run: `bun test lib/daemon`
Expected: PASS (no existing test asserts a specific absence of `maxRequestBodySize`)

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/request-limits.ts lib/daemon/api-server.ts lib/daemon/socket-server.ts lib/daemon/__tests__/request-body-size.test.ts
git commit -m "daemon: cap request body size at 1 MiB on both servers (S092)"
```

---

## Task 2: One shared api-token loader, with a warn on persist failure (S054)

**Files:**
- Modify: `lib/daemon/api-auth.ts`
- Modify: `lib/daemon/api-server.ts` (use the new getter instead of the raw loader)
- Modify: `lib/daemon/handlers/secrets.ts` (use the new getter as the default override)
- Test: `lib/daemon/__tests__/api-auth.test.ts` (extend)

**Interfaces:**
- Produces: `export function getApiToken(tokenPath?: string): string` and `export function reloadApiToken(tokenPath?: string): string` from `lib/daemon/api-auth.ts`. `loadOrCreateApiToken` keeps its existing signature and export (still the underlying file I/O primitive; `getApiToken`/`reloadApiToken` wrap it with an in-memory cache).
- Consumes: `lazyChildLogger` from `../daemon-logger.ts` (already exported; see `getDaemonLogger`/`lazyChildLogger` in `lib/daemon-logger.ts`).

- [ ] **Step 1: Write the failing test**

Append to `lib/daemon/__tests__/api-auth.test.ts`:

```ts
import { getApiToken, reloadApiToken, loadOrCreateApiToken } from "../api-auth.ts";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("getApiToken / reloadApiToken singleton", () => {
  test("getApiToken caches: a second call does not re-read the file even if it changes underneath", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-api-token-"));
    const tokenPath = join(dir, "api-token");
    try {
      const first = reloadApiToken(tokenPath); // seed the cache with a known path
      writeFileSync(tokenPath, "a-different-token", { mode: 0o600 });
      const second = getApiToken(tokenPath); // ignores the new file content -- cached
      expect(second).toBe(first);
      expect(second).not.toBe("a-different-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reloadApiToken re-reads and updates the cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-api-token-"));
    const tokenPath = join(dir, "api-token");
    try {
      reloadApiToken(tokenPath);
      writeFileSync(tokenPath, "rotated-token", { mode: 0o600 });
      const reloaded = reloadApiToken(tokenPath);
      expect(reloaded).toBe("rotated-token");
      expect(getApiToken(tokenPath)).toBe("rotated-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadOrCreateApiToken still works standalone (unchanged primitive)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-api-token-"));
    const tokenPath = join(dir, "api-token");
    try {
      const a = loadOrCreateApiToken(tokenPath);
      const b = loadOrCreateApiToken(tokenPath);
      expect(a).toBe(b);
      expect(a.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/daemon/__tests__/api-auth.test.ts`
Expected: FAIL — `getApiToken`/`reloadApiToken` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

In `lib/daemon/api-auth.ts`, add near the top (after the existing imports) and after `loadOrCreateApiToken`:

```ts
import { lazyChildLogger } from "../daemon-logger.ts";

const log = lazyChildLogger("api-auth");
```

Change the existing `loadOrCreateApiToken`'s silent write-failure catch to log a warning (this is the only edit to that function's body):

```ts
export function loadOrCreateApiToken(tokenPath: string = API_TOKEN_PATH): string {
  try {
    if (existsSync(tokenPath)) {
      const existing = readFileSync(tokenPath, "utf8").trim();
      if (existing) return existing;
    }
  } catch { /* fall through to regenerate */ }
  const token = randomUUID();
  try {
    mkdirSync(RT_DIR, { recursive: true });
    writeFileSync(tokenPath, token, { mode: 0o600 });
  } catch (err) {
    log.warn({ err, tokenPath }, "could not persist api-token; enforced in-memory only this run, so a client reading the file will disagree until the daemon restarts");
  }
  return token;
}

/**
 * `getApiToken`/`reloadApiToken` share ONE in-memory value between
 * api-server.ts and the secrets handler (S054): before this, api-server
 * captured a token once at boot while the secrets handler called
 * `loadOrCreateApiToken()` fresh on every request, so an external rotation
 * (deleting api-token to force a new one) left the two permanently
 * disagreeing about which token is current -- and if the token dir was
 * unwritable, the secrets handler regenerated a brand new random token on
 * every single call, never matching anything a client could read from disk.
 * Both consumers now read the SAME cached value; a rotation only takes
 * effect for both after `reloadApiToken()` runs or the daemon restarts,
 * either of which was already the closest thing to a happy path before.
 */
let cachedApiToken: string | null = null;

export function getApiToken(tokenPath: string = API_TOKEN_PATH): string {
  if (cachedApiToken === null) cachedApiToken = loadOrCreateApiToken(tokenPath);
  return cachedApiToken;
}

export function reloadApiToken(tokenPath: string = API_TOKEN_PATH): string {
  cachedApiToken = loadOrCreateApiToken(tokenPath);
  return cachedApiToken;
}
```

In `lib/daemon/api-server.ts`, change the import and the one call site:

```ts
import { needsToken, tokenOk, getApiToken } from "./api-auth.ts";
```

```ts
  const apiToken = getApiToken();
```

(replaces `const apiToken = loadOrCreateApiToken();`)

In `lib/daemon/handlers/secrets.ts`, change the import and the one default-override:

```ts
import { getApiToken, tokenOk } from "../api-auth.ts";
```

```ts
  /** Defaults to `getApiToken` (the real ~/.mattstack/rt/api-token, shared with api-auth.ts and api-server.ts). */
  apiToken?: () => string;
```

(only the doc comment line changes; the field name/type is unchanged)

```ts
  const apiToken = overrides.apiToken ?? (() => getApiToken());
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/daemon/__tests__/api-auth.test.ts lib/daemon/__tests__/secrets-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full daemon test slice**

Run: `bun test lib/daemon`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/api-auth.ts lib/daemon/api-server.ts lib/daemon/handlers/secrets.ts lib/daemon/__tests__/api-auth.test.ts
git commit -m "daemon: one shared api-token cache for api-server and secrets handler (S054)"
```

---

## Task 3: Origin allowlist settings key + trust helper + needsToken invert-default (S005, S006, S040, S041, S084)

**Files:**
- Modify: `packages/rt-client/src/settings/registry-defs.ts`
- Modify: `lib/daemon/api-auth.ts`
- Test: `lib/daemon/__tests__/api-auth.test.ts` (extend)

**Interfaces:**
- Produces:
  - `export function getTrustedBrowserOrigins(): readonly string[]` (reads the `rt.trustedBrowserOrigins` setting, `[]` on any error or when unset)
  - `export function isOriginAllowed(origin: string, allowedOrigins: readonly string[]): boolean`
  - `export function isBrowserRequestTrusted(origin: string | null, token: string | null, apiToken: string, allowedOrigins: readonly string[]): boolean` (the shared decision Task 4 wires into both the CORS header and the `/ws` gate: no `Origin` header at all -> trusted (non-browser); otherwise a valid token OR an allowlisted origin)
  - `needsToken(method, pathname)` changes shape: default-gated for every method except `GET`/`HEAD`/`OPTIONS`, plus two explicit GET exceptions (`/api/secrets`, `/api/notifications`) that are gated despite being reads.
- Consumes: `getSetting` from `../settings/resolve.ts` (already re-exported from `@mattstack/rt-client`; see `lib/chat-viewer-url.ts` for the exact import/usage pattern), `tokenOk` (already in this file).

- [ ] **Step 1: Add the registry key**

In `packages/rt-client/src/settings/registry-defs.ts`, add a new entry after the `rt.hooks` block (around line 207, right before the `// --- mattstack (installer-lane) ---` comment):

```ts
  {
    key: "rt.trustedBrowserOrigins",
    type: "array",
    scopes: ["user", "machine"],
    default: [],
    merge: "replace",
    description: "Browser Origins (scheme://host:port, exact string match) trusted to read the :9401 daemon API and subscribe to /ws without presenting the local api-token -- e.g. a locally-hosted console or chat-viewer dev server. Empty by default: every current mattstack consumer (the CLI, the Swift tray, rt-client from Bun/Node processes, the VS Code extension) is a non-browser client (sends no Origin header at all) and is unaffected either way.",
  },
```

- [ ] **Step 2: Build rt-client so the new key is live for tests that resolve it**

Run: `cd packages/rt-client && bun run build && cd -`
Expected: build succeeds; `dist/` picks up the new registry row.

- [ ] **Step 3: Write the failing tests**

Append to `lib/daemon/__tests__/api-auth.test.ts`:

```ts
import { isOriginAllowed, isBrowserRequestTrusted, getTrustedBrowserOrigins } from "../api-auth.ts";

describe("isOriginAllowed", () => {
  test("exact match", () => {
    expect(isOriginAllowed("http://localhost:5544", ["http://localhost:5544"])).toBe(true);
  });
  test("no match", () => {
    expect(isOriginAllowed("http://evil.example", ["http://localhost:5544"])).toBe(false);
  });
  test("empty allowlist matches nothing", () => {
    expect(isOriginAllowed("http://localhost:5544", [])).toBe(false);
  });
});

describe("isBrowserRequestTrusted", () => {
  const apiToken = "the-real-token";

  test("no Origin header at all -- a non-browser client -- is trusted regardless of token or allowlist", () => {
    expect(isBrowserRequestTrusted(null, null, apiToken, [])).toBe(true);
  });

  test("a browser Origin with the correct token is trusted even off the allowlist", () => {
    expect(isBrowserRequestTrusted("http://evil.example", apiToken, apiToken, [])).toBe(true);
  });

  test("a browser Origin with a wrong token and not on the allowlist is rejected", () => {
    expect(isBrowserRequestTrusted("http://evil.example", "wrong", apiToken, [])).toBe(false);
  });

  test("a browser Origin with no token but on the allowlist is trusted", () => {
    expect(isBrowserRequestTrusted("http://localhost:5544", null, apiToken, ["http://localhost:5544"])).toBe(true);
  });

  test("a browser Origin with no token and not on the allowlist is rejected", () => {
    expect(isBrowserRequestTrusted("http://localhost:5544", null, apiToken, [])).toBe(false);
  });
});

describe("getTrustedBrowserOrigins", () => {
  test("returns an array (empty by default in an isolated test HOME)", () => {
    const origins = getTrustedBrowserOrigins();
    expect(Array.isArray(origins)).toBe(true);
  });
});
```

Also extend the existing `needsToken` describe block in the same file with the new cases (add these `test`s inside the existing `describe("needsToken", ...)`):

```ts
  test("refresh requires a token now (S040)", () => {
    expect(needsToken("POST", "/api/refresh")).toBe(true);
  });

  test("hooks repair requires a token now (S040/S084)", () => {
    expect(needsToken("POST", "/api/hooks/my-repo/repair")).toBe(true);
  });

  test("notifications GET (destructive drain) requires a token now (S041)", () => {
    expect(needsToken("GET", "/api/notifications")).toBe(true);
  });

  test("every non-GET/HEAD/OPTIONS method defaults to requiring a token", () => {
    expect(needsToken("POST", "/api/some-future-mutating-route")).toBe(true);
    expect(needsToken("PUT", "/api/anything")).toBe(true);
    expect(needsToken("DELETE", "/api/anything")).toBe(true);
  });

  test("plain reads still do not require a token", () => {
    expect(needsToken("GET", "/api/repos")).toBe(false);
    expect(needsToken("GET", "/api/cache")).toBe(false);
    expect(needsToken("HEAD", "/api/repos")).toBe(false);
  });
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `bun test lib/daemon/__tests__/api-auth.test.ts`
Expected: FAIL — `isOriginAllowed`/`isBrowserRequestTrusted`/`getTrustedBrowserOrigins` not exported; the two new `needsToken` cases for `/api/refresh` and `/api/hooks/.../repair` and `/api/notifications` fail against the current allowlist-based implementation.

- [ ] **Step 5: Write minimal implementation**

In `lib/daemon/api-auth.ts`, add the import (alongside the existing ones) and the new functions:

```ts
import { getSetting } from "../settings/resolve.ts";
```

```ts
/**
 * `rt.trustedBrowserOrigins` -- see registry-defs.ts. Read fresh on every
 * call (the settings resolver is deliberately unmemoized), wrapped in a
 * try/catch since a request-path settings read must never 500 the daemon
 * over a malformed store file.
 */
export function getTrustedBrowserOrigins(): readonly string[] {
  try {
    const resolved = getSetting<string[]>("rt.trustedBrowserOrigins");
    return Array.isArray(resolved.value) ? resolved.value : [];
  } catch {
    return [];
  }
}

export function isOriginAllowed(origin: string, allowedOrigins: readonly string[]): boolean {
  return allowedOrigins.includes(origin);
}

/**
 * The 127.0.0.1 trust boundary (S005/S006): the daemon binds loopback-only,
 * but any web page the user visits also runs on 127.0.0.1 and can send a
 * request. A request with NO Origin header at all is not a browser fetch --
 * it is the CLI, the Swift tray, rt-client from a Bun/Node process, or the
 * VS Code extension, none of which send one -- so it is trusted unchanged.
 * A request that DOES carry an Origin header is trusted only if it presents
 * the local api-token or its Origin is on the explicit allowlist.
 */
export function isBrowserRequestTrusted(
  origin: string | null,
  token: string | null,
  apiToken: string,
  allowedOrigins: readonly string[],
): boolean {
  if (!origin) return true;
  if (tokenOk(token, apiToken)) return true;
  return isOriginAllowed(origin, allowedOrigins);
}
```

Replace the whole `needsToken` function with:

```ts
/**
 * True when a request mutates state, or (secrets/notifications) returns or
 * drains something a GET should not silently consume, and must present the
 * local token. Default-gated for every method except GET/HEAD/OPTIONS (S040:
 * an allowlist-by-path guaranteed the next mutating route would ship
 * unguarded) plus two explicit GET exceptions whose verb lies about being a
 * read.
 */
export function needsToken(method: string, pathname: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    // Gated despite being a GET: /api/secrets's response body IS a
    // credential (S054); /api/notifications DRAINS the queue (S041), so its
    // verb lies about being a read the way every other GET here is not.
    if (pathname === "/api/secrets") return true;
    if (pathname === "/api/notifications") return true;
    return false;
  }
  return true;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test lib/daemon/__tests__/api-auth.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full daemon test slice and tsc**

Run: `bun test lib/daemon`
Run: `bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add packages/rt-client/src/settings/registry-defs.ts packages/rt-client/dist lib/daemon/api-auth.ts lib/daemon/__tests__/api-auth.test.ts
git commit -m "daemon: rt.trustedBrowserOrigins allowlist + needsToken invert-default (S005/S006/S040/S041/S084)"
```

---

## Task 4: Wire CORS default-deny and the `/ws` origin/token gate into api-server.ts (S005, S006)

**Files:**
- Modify: `lib/daemon/api-server.ts`
- Test: `lib/daemon/__tests__/api-server-cors-ws.test.ts` (new)

**Interfaces:**
- Consumes: `isBrowserRequestTrusted`, `getTrustedBrowserOrigins` from `./api-auth.ts` (Task 3).
- Produces: `export function buildCorsHeaders(origin: string | null, trusted: boolean): Record<string, string>` — a pure function so the header-shape logic is unit-testable without a real server. The live `/ws` gate and the live CORS-header wiring inside `fetch()` are exercised indirectly through this same function plus the `isBrowserRequestTrusted` tests from Task 3 (this codebase's existing convention -- see `bindApiServerWithRetry` -- is to keep the decision logic in pure, tested functions and keep the `Bun.serve` wiring itself thin).

- [ ] **Step 1: Write the failing test**

```ts
// lib/daemon/__tests__/api-server-cors-ws.test.ts
import { describe, test, expect } from "bun:test";
import { buildCorsHeaders } from "../api-server.ts";

describe("buildCorsHeaders", () => {
  test("no Origin header: no Access-Control-Allow-Origin is set (non-browser request, CORS is irrelevant)", () => {
    const headers = buildCorsHeaders(null, true);
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  test("an untrusted Origin gets no Access-Control-Allow-Origin (default-deny, S006)", () => {
    const headers = buildCorsHeaders("http://evil.example", false);
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  test("a trusted Origin is echoed back with Vary: Origin", () => {
    const headers = buildCorsHeaders("http://localhost:5544", true);
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:5544");
    expect(headers["Vary"]).toBe("Origin");
  });

  test("always advertises the methods/headers a preflight needs, trusted or not", () => {
    const headers = buildCorsHeaders("http://evil.example", false);
    expect(headers["Access-Control-Allow-Methods"]).toContain("POST");
    expect(headers["Access-Control-Allow-Headers"]).toContain("X-RT-Token");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/daemon/__tests__/api-server-cors-ws.test.ts`
Expected: FAIL — `buildCorsHeaders` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

In `lib/daemon/api-server.ts`, change the import line to add the two new helpers:

```ts
import { needsToken, tokenOk, getApiToken, isBrowserRequestTrusted, getTrustedBrowserOrigins } from "./api-auth.ts";
```

Add this exported pure function near the top of the file (after the `wsClients`/`broadcast` block, before `startApiServer`):

```ts
/**
 * CORS default-deny (S006): a browser page on an untrusted Origin still gets
 * its request served (127.0.0.1 loopback + the per-route token gate are the
 * real defenses), but the response carries no Access-Control-Allow-Origin,
 * so the page's own JavaScript cannot read the body. A request with no
 * Origin at all (every non-browser consumer today) needs no CORS headers.
 */
export function buildCorsHeaders(origin: string | null, trusted: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-RT-Token",
  };
  if (origin && trusted) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}
```

Now replace the body of `fetch(req, server)` from the top through the old `corsHeaders` declaration. The current code (for reference) is:

```ts
    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade — broadcast channel
      if (url.pathname === "/ws") {
        if (server.upgrade(req, { data: { kind: "broadcast" } })) return undefined as any;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // CORS headers for local dev
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };
```

Replace it with:

```ts
    async fetch(req, server) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      const allowedOrigins = getTrustedBrowserOrigins();

      // WebSocket upgrade — broadcast channel. Browsers cannot set custom
      // headers on a WS handshake, so the token (when a browser page wants
      // to identify itself) travels as a ?token= query param instead of
      // X-RT-Token (S005).
      if (url.pathname === "/ws") {
        const wsToken = url.searchParams.get("token");
        if (!isBrowserRequestTrusted(origin, wsToken, apiToken, allowedOrigins)) {
          return new Response("origin not allowed", { status: 403 });
        }
        if (server.upgrade(req, { data: { kind: "broadcast" } })) return undefined as any;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // CORS: default-deny. A trusted Origin (token or allowlist) gets its
      // Origin echoed back; anything else gets no Access-Control-Allow-Origin
      // at all, so a malicious page's own JS cannot read the response (S006).
      const trusted = isBrowserRequestTrusted(origin, req.headers.get("x-rt-token"), apiToken, allowedOrigins);
      const corsHeaders = buildCorsHeaders(origin, trusted);
```

No other lines in `fetch()` need to change — every later reference to `corsHeaders` in the function already reads from this same local binding.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/daemon/__tests__/api-server-cors-ws.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full daemon test slice and tsc**

Run: `bun test lib/daemon`
Run: `bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/api-server.ts lib/daemon/__tests__/api-server-cors-ws.test.ts
git commit -m "daemon: default-deny CORS and gate /ws on origin/token (S005/S006)"
```

---

## Task 5: broadcast() drops dead/backpressured WS clients (S042)

**Files:**
- Modify: `lib/daemon/api-server.ts`
- Test: `lib/daemon/__tests__/api-server-broadcast.test.ts` (new)

**Interfaces:**
- Produces: `export function broadcastToClients(clients: Iterable<BroadcastTarget>, type: string, data: any, log: { warn: (o: unknown, m: string) => void }): void` where `BroadcastTarget = { send(data: string): number; close(): void }` (exported type). `broadcast()` becomes a thin wrapper calling `broadcastToClients(wsClients, type, data, log)`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

```ts
// lib/daemon/__tests__/api-server-broadcast.test.ts
import { describe, test, expect } from "bun:test";
import { broadcastToClients, type BroadcastTarget } from "../api-server.ts";

function fakeClient(sendReturns: number[]): BroadcastTarget & { closed: boolean; sent: string[] } {
  const sent: string[] = [];
  let i = 0;
  const client = {
    closed: false,
    sent,
    send(data: string) {
      sent.push(data);
      const ret = sendReturns[Math.min(i, sendReturns.length - 1)];
      i++;
      return ret;
    },
    close() { client.closed = true; },
  };
  return client;
}

function fakeLog() {
  const warns: unknown[] = [];
  return { warn: (o: unknown, _m: string) => { warns.push(o); }, warns };
}

describe("broadcastToClients", () => {
  test("a healthy client (positive send return) is never closed", () => {
    const client = fakeClient([42]);
    broadcastToClients([client], "status", { ok: true }, fakeLog());
    expect(client.closed).toBe(false);
    expect(client.sent.length).toBe(1);
  });

  test("a send() returning 0 (dropped frame) closes the client immediately and logs a warning", () => {
    const client = fakeClient([0]);
    const log = fakeLog();
    broadcastToClients([client], "status", { ok: true }, log);
    expect(client.closed).toBe(true);
    expect(log.warns.length).toBe(1);
  });

  test("a send() returning -1 (backpressure) is tolerated for a few sends before closing", () => {
    const client = fakeClient([-1, -1, -1, -1]);
    const log = fakeLog();
    broadcastToClients([client], "a", {}, log);
    expect(client.closed).toBe(false);
    broadcastToClients([client], "b", {}, log);
    expect(client.closed).toBe(false);
    broadcastToClients([client], "c", {}, log);
    // third consecutive backpressure event closes the client
    expect(client.closed).toBe(true);
  });

  test("a successful send resets the backpressure counter", () => {
    const client = fakeClient([-1, -1, 99, -1, -1, -1]);
    const log = fakeLog();
    broadcastToClients([client], "a", {}, log); // -1 (count=1)
    broadcastToClients([client], "b", {}, log); // -1 (count=2)
    broadcastToClients([client], "c", {}, log); // 99 -- resets to 0
    expect(client.closed).toBe(false);
    broadcastToClients([client], "d", {}, log); // -1 (count=1)
    broadcastToClients([client], "e", {}, log); // -1 (count=2)
    expect(client.closed).toBe(false);
    broadcastToClients([client], "f", {}, log); // -1 (count=3) -- closes
    expect(client.closed).toBe(true);
  });

  test("a client whose send() throws is treated as gone: caught, not propagated", () => {
    const client: BroadcastTarget = {
      send() { throw new Error("ECONNRESET"); },
      close() { /* no-op */ },
    };
    expect(() => broadcastToClients([client], "a", {}, fakeLog())).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/daemon/__tests__/api-server-broadcast.test.ts`
Expected: FAIL — `broadcastToClients`/`BroadcastTarget` not exported yet.

- [ ] **Step 3: Write minimal implementation**

Replace the existing `broadcast()` function and the `wsClients` declaration block in `lib/daemon/api-server.ts`:

Current code (for reference):

```ts
const wsClients = new Set<ServerWebSocket<ApiWSData>>();

/** Broadcast an event to all connected WebSocket clients. */
export function broadcast(type: string, data: any): void {
  if (wsClients.size === 0) return;
  const msg = JSON.stringify({ type, data, timestamp: Date.now() });
  for (const ws of wsClients) {
    try { ws.send(msg); } catch { /* client disconnected */ }
  }
}
```

Replace with:

```ts
const wsClients = new Set<ServerWebSocket<ApiWSData>>();

/** Consecutive Bun `ws.send()` backpressure (-1) returns tolerated before a
    client is dropped as chronically stalled. */
const BACKPRESSURE_CLOSE_THRESHOLD = 3;
const backpressureCounts = new WeakMap<object, number>();

export interface BroadcastTarget {
  send(data: string): number;
  close(): void;
}

/**
 * Sends one frame to every client, dropping any that Bun's own send() return
 * value marks as gone (S042). `ws.send()` never throws on a dead socket --
 * it returns 0 (this send silently failed) or -1 (backpressure) -- so a
 * disconnected or stalled console/chat-viewer tab used to keep receiving a
 * SUBSET of frames forever with nothing logged. 0 means Bun already dropped
 * this exact frame for this client: closing immediately (rather than
 * counting) is correct because the client's own reconnect logic is the only
 * way it recovers a consistent stream. -1 means backpressure, which can be
 * transient, so a few in a row are tolerated before giving up on the client.
 */
export function broadcastToClients(
  clients: Iterable<BroadcastTarget>,
  type: string,
  data: any,
  log: { warn: (o: unknown, m: string) => void },
): void {
  const msg = JSON.stringify({ type, data, timestamp: Date.now() });
  for (const client of clients) {
    let result: number;
    try {
      result = client.send(msg);
    } catch (err) {
      log.warn({ err }, "ws client send threw; dropping");
      try { client.close(); } catch { /* already gone */ }
      continue;
    }
    if (result === 0) {
      log.warn({ type }, "ws client dropped a frame (send()=0); closing so its reconnect resyncs");
      backpressureCounts.delete(client);
      try { client.close(); } catch { /* already gone */ }
    } else if (result === -1) {
      const count = (backpressureCounts.get(client) ?? 0) + 1;
      if (count >= BACKPRESSURE_CLOSE_THRESHOLD) {
        log.warn({ type, count }, "ws client chronically backpressured; closing");
        backpressureCounts.delete(client);
        try { client.close(); } catch { /* already gone */ }
      } else {
        backpressureCounts.set(client, count);
      }
    } else {
      backpressureCounts.delete(client);
    }
  }
}

/** Broadcast an event to all connected WebSocket clients. */
export function broadcast(type: string, data: any): void {
  if (wsClients.size === 0) return;
  broadcastToClients(wsClients, type, data, apiServerLog);
}
```

This introduces one new module-level binding, `apiServerLog`, since `broadcast()` previously had no logger in scope at all (it is called from many places across the daemon, not just from inside `startApiServer`). Add it right after the existing `wsClients`-adjacent declarations, and set it from `startApiServer`:

```ts
let apiServerLog: { warn: (o: unknown, m: string) => void } = { warn: () => {} };
```

...and inside `startApiServer`, right after `const { handleCommand, log } = deps;`, add:

```ts
  apiServerLog = log;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/daemon/__tests__/api-server-broadcast.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full daemon test slice and tsc**

Run: `bun test lib/daemon`
Run: `bunx tsc --noEmit`
Expected: both clean. (`ServerWebSocket<ApiWSData>` structurally satisfies `BroadcastTarget` since it has both `send(string): number` and `close(): void`, so `broadcastToClients(wsClients, ...)` type-checks with no cast.)

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/api-server.ts lib/daemon/__tests__/api-server-broadcast.test.ts
git commit -m "daemon: broadcast() drops dead/backpressured ws clients instead of silently dropping frames (S042)"
```

---

## Task 6: pathParam() helper — malformed %-encoding returns 400, not a logged 500 (S083)

**Files:**
- Modify: `lib/daemon/api-server.ts`
- Test: `lib/daemon/__tests__/api-server-path-param.test.ts` (new)

**Interfaces:**
- Produces: `export function pathParam(pathname: string, prefix: string, suffix?: string): string | undefined` (returns `undefined` when the pathname doesn't match the prefix/suffix shape, the captured segment is empty, or `decodeURIComponent` throws).

- [ ] **Step 1: Write the failing test**

```ts
// lib/daemon/__tests__/api-server-path-param.test.ts
import { describe, test, expect } from "bun:test";
import { pathParam } from "../api-server.ts";

describe("pathParam", () => {
  test("decodes a clean prefix-only param", () => {
    expect(pathParam("/api/cache/main", "/api/cache/")).toBe("main");
  });

  test("decodes a URL-encoded segment", () => {
    expect(pathParam("/api/cache/feature%2Ffoo", "/api/cache/")).toBe("feature/foo");
  });

  test("returns undefined for malformed %-encoding instead of throwing", () => {
    expect(pathParam("/api/cache/%E0%A4%A", "/api/cache/")).toBeUndefined();
  });

  test("returns undefined when the pathname doesn't start with the prefix", () => {
    expect(pathParam("/api/other/main", "/api/cache/")).toBeUndefined();
  });

  test("handles a prefix+suffix pair (hooks repair shape)", () => {
    expect(pathParam("/api/hooks/my-repo/repair", "/api/hooks/", "/repair")).toBe("my-repo");
  });

  test("prefix+suffix: malformed encoding still returns undefined", () => {
    expect(pathParam("/api/hooks/%E0%A4%A/repair", "/api/hooks/", "/repair")).toBeUndefined();
  });

  test("prefix+suffix: wrong suffix returns undefined", () => {
    expect(pathParam("/api/hooks/my-repo/other", "/api/hooks/", "/repair")).toBeUndefined();
  });

  test("an empty captured segment returns undefined", () => {
    expect(pathParam("/api/cache/", "/api/cache/")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/daemon/__tests__/api-server-path-param.test.ts`
Expected: FAIL — `pathParam` not exported yet.

- [ ] **Step 3: Write minimal implementation**

Add this exported function to `lib/daemon/api-server.ts` (near `buildCorsHeaders`, before `startApiServer`):

```ts
/**
 * Decodes one path segment between a fixed prefix (and optional suffix),
 * returning `undefined` (never throwing) on any shape mismatch or malformed
 * %-encoding (S083). Before this, each parameterized route hand-rolled its
 * own decodeURIComponent inside the route's try block, so a malformed
 * segment fell through to the OUTER catch and came back as a logged 500;
 * every route using this helper instead gets a clean 400.
 */
export function pathParam(pathname: string, prefix: string, suffix = ""): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  if (suffix && !pathname.endsWith(suffix)) return undefined;
  const end = suffix ? pathname.length - suffix.length : pathname.length;
  if (end <= prefix.length) return undefined;
  const raw = pathname.slice(prefix.length, end);
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}
```

Now wire it into the three routes inside `fetch()`. Replace the `/api/cache/:branch` block:

```ts
        // Single branch lookup: /api/cache/:branch
        if (url.pathname.startsWith("/api/cache/") && req.method === "GET") {
          const branch = pathParam(url.pathname, "/api/cache/");
          if (branch === undefined) {
            return Response.json({ ok: false, error: "malformed path parameter" }, { status: 400, headers: corsHeaders });
          }
          const result = await handleCommand("cache:read", { branches: [branch] }, req.signal);
          return Response.json(result, { headers: corsHeaders });
        }
```

Replace the `/api/hooks/:repo/repair` block:

```ts
        // Hooks repair: /api/hooks/:repo/repair
        if (url.pathname.startsWith("/api/hooks/") && url.pathname.endsWith("/repair") && req.method === "POST") {
          const repo = pathParam(url.pathname, "/api/hooks/", "/repair");
          if (repo === undefined) {
            return Response.json({ ok: false, error: "malformed path parameter" }, { status: 400, headers: corsHeaders });
          }
          const result = await handleCommand("hooks:repair", { repo }, req.signal);
          return Response.json(result, { headers: corsHeaders });
        }
```

Replace the `/api/runs/:repo/:runId` block (this one already guarded against the URIError; simplify it onto the shared helper so there is one decode path in the file, not two):

```ts
        // Runs detail: /api/runs/:repo/:runId
        if (url.pathname.startsWith("/api/runs/") && req.method === "GET") {
          const rest = pathParam(url.pathname, "/api/runs/");
          if (rest === undefined) {
            return Response.json({ ok: false, error: "malformed path parameter" }, { status: 400, headers: corsHeaders });
          }
          const slash = rest.indexOf("/");
          if (slash > 0 && slash < rest.length - 1) {
            const result = await handleCommand("runs:get", { repo: rest.slice(0, slash), runId: rest.slice(slash + 1) }, req.signal);
            return Response.json(result, { headers: corsHeaders });
          }
          // falls through to the 404 path below for a shape mismatch, e.g. "/api/runs/onlyonesegment"
        }
```

Note the behavior change from before: a malformed `/api/runs/...` now returns 400 instead of falling through to the generic 404. This is intentional and matches S083's ask across all three routes uniformly (a malformed path parameter is a 400, a genuinely unknown route is a 404); update no other test, since no existing test in this repo asserts the old runs-route 500-vs-404 distinction (grep `lib/daemon/__tests__/` for `runs:get` before assuming otherwise, and if one exists, adjust it to expect 400 for the malformed case instead of removing coverage).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/daemon/__tests__/api-server-path-param.test.ts`
Expected: PASS

- [ ] **Step 5: Check for an existing runs-route test that might need updating**

Run: `grep -rn "runs:get\|/api/runs/" lib/daemon/__tests__/`
If a test asserts the old 500-on-malformed or 404-on-malformed behavior for `/api/runs/`, update its expected status to 400 to match the new shared helper.

- [ ] **Step 6: Run the full daemon test slice and tsc**

Run: `bun test lib/daemon`
Run: `bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add lib/daemon/api-server.ts lib/daemon/__tests__/api-server-path-param.test.ts
git commit -m "daemon: pathParam() helper -- malformed %-encoding is a 400, not a logged 500 (S083)"
```

---

## Task 7: GET query param coercion (S085)

**Files:**
- Modify: `lib/daemon/api-server.ts`
- Test: `lib/daemon/__tests__/api-server-query-coerce.test.ts` (new)

**Interfaces:**
- Produces: `export function coerceQueryParams(params: URLSearchParams): Record<string, unknown>` — converts `"true"`/`"false"` to booleans and plain-integer/decimal strings to numbers; everything else stays a string.

- [ ] **Step 1: Write the failing test**

```ts
// lib/daemon/__tests__/api-server-query-coerce.test.ts
import { describe, test, expect } from "bun:test";
import { coerceQueryParams } from "../api-server.ts";

describe("coerceQueryParams", () => {
  test("coerces maxAgeMs to a number (the documented cache:read flag)", () => {
    const out = coerceQueryParams(new URLSearchParams("maxAgeMs=60000"));
    expect(out.maxAgeMs).toBe(60000);
    expect(typeof out.maxAgeMs).toBe("number");
  });

  test("coerces refresh=true to a boolean (the documented ports flag)", () => {
    const out = coerceQueryParams(new URLSearchParams("refresh=true"));
    expect(out.refresh).toBe(true);
  });

  test("coerces refresh=false to a boolean false, not a truthy string", () => {
    const out = coerceQueryParams(new URLSearchParams("refresh=false"));
    expect(out.refresh).toBe(false);
  });

  test("leaves a non-numeric, non-boolean string alone", () => {
    const out = coerceQueryParams(new URLSearchParams("repo=my-repo-name"));
    expect(out.repo).toBe("my-repo-name");
  });

  test("leaves an empty string alone rather than coercing to 0", () => {
    const out = coerceQueryParams(new URLSearchParams("q="));
    expect(out.q).toBe("");
  });

  test("coerces a decimal number too", () => {
    const out = coerceQueryParams(new URLSearchParams("ratio=1.5"));
    expect(out.ratio).toBe(1.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/daemon/__tests__/api-server-query-coerce.test.ts`
Expected: FAIL — `coerceQueryParams` not exported yet.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/daemon/api-server.ts` (near `pathParam`):

```ts
const PLAIN_NUMBER_RE = /^-?\d+(\.\d+)?$/;

/**
 * REST query strings arrive as strings no matter what the client meant
 * (S085): `?maxAgeMs=60000` and `?refresh=true` reached handlers that do a
 * strict `typeof x === "number"` or `x === true` check, so the documented
 * flag silently no-op'd over HTTP while working over the socket (where
 * payloads are real JSON). One coercion at the REST seam fixes every such
 * flag at once instead of a per-handler private parser.
 */
export function coerceQueryParams(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of params) {
    if (value === "true") out[key] = true;
    else if (value === "false") out[key] = false;
    else if (value !== "" && PLAIN_NUMBER_RE.test(value)) out[key] = Number(value);
    else out[key] = value;
  }
  return out;
}
```

Change the payload-building line inside `fetch()` from:

```ts
        } else {
          payload = Object.fromEntries(url.searchParams);
        }
```

to:

```ts
        } else {
          payload = coerceQueryParams(url.searchParams);
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/daemon/__tests__/api-server-query-coerce.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full daemon test slice and tsc**

Run: `bun test lib/daemon`
Run: `bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/api-server.ts lib/daemon/__tests__/api-server-query-coerce.test.ts
git commit -m "daemon: coerce REST GET query params to number/boolean at the seam (S085)"
```

---

## Task 8: ApiPortInUseError + lsof diagnostics when bind retries are exhausted (S043 addendum)

**Files:**
- Modify: `lib/daemon/api-server.ts`
- Test: `lib/daemon/__tests__/api-server-bind.test.ts` (extend)

**Interfaces:**
- Produces: `export class ApiPortInUseError extends Error { readonly code: "EADDRINUSE"; readonly port: number }`. `BindRetryDeps` grows an optional `probePortHolder?: (port: number) => Promise<string>` field (defaults to a real `lsof -i :<port>` via `runCapture`). `bindApiServerWithRetry` throws `ApiPortInUseError` (instead of the raw EADDRINUSE `Error`) once `BIND_RETRY_ATTEMPTS` is exhausted, after logging the probe result at `warn`.
- Consumes: `runCapture` from `../subprocess.ts`.
- **Contract for the sibling job owning `lib/daemon.ts`'s caller side:** catch `ApiPortInUseError` (check `err instanceof ApiPortInUseError`, or `err.name === "ApiPortInUseError"`) around the `startApiServer()` call and route to a park-and-retry-with-backoff loop instead of letting it propagate to the top-level crash/unhandledRejection path. Every other error out of `startApiServer()` is a real misconfiguration and should keep crashing as it does today.

- [ ] **Step 1: Write the failing test**

Append to `lib/daemon/__tests__/api-server-bind.test.ts`:

```ts
import { ApiPortInUseError, BIND_RETRY_ATTEMPTS } from "../api-server.ts";

function depsWithProbe(overrides: Partial<BindRetryDeps> = {}) {
  const logs: Array<{ o: unknown; m: string }> = [];
  const sleeps: number[] = [];
  const probeCalls: number[] = [];
  return {
    sleep: async (ms: number) => { sleeps.push(ms); },
    log: { warn: (o: unknown, m: string) => logs.push({ o, m }) },
    probePortHolder: async (port: number) => { probeCalls.push(port); return "COMMAND PID USER\nnode 123 matt"; },
    logs,
    sleeps,
    probeCalls,
    ...overrides,
  };
}

describe("bindApiServerWithRetry — exhausted retries (S043)", () => {
  test("throws ApiPortInUseError (not the raw EADDRINUSE Error) once attempts are exhausted", async () => {
    const d = depsWithProbe();
    let error: unknown;
    try {
      await bindApiServerWithRetry(() => { throw eaddrinuse(); }, d);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ApiPortInUseError);
    expect((error as ApiPortInUseError).code).toBe("EADDRINUSE");
    expect((error as Error).message).toContain("EADDRINUSE");
  });

  test("probes the port holder exactly once, only after the final attempt", async () => {
    const d = depsWithProbe();
    let calls = 0;
    await expect(
      bindApiServerWithRetry(() => { calls++; throw eaddrinuse(); }, d),
    ).rejects.toBeInstanceOf(ApiPortInUseError);
    expect(calls).toBe(BIND_RETRY_ATTEMPTS);
    expect(d.probeCalls.length).toBe(1);
  });

  test("logs the probe result at warn before throwing", async () => {
    const d = depsWithProbe();
    await expect(
      bindApiServerWithRetry(() => { throw eaddrinuse(); }, d),
    ).rejects.toBeInstanceOf(ApiPortInUseError);
    const finalWarn = d.logs.at(-1)!;
    expect(finalWarn.o).toMatchObject({ holder: expect.stringContaining("node") });
  });

  test("a probe failure does not prevent the ApiPortInUseError from being thrown", async () => {
    const d = depsWithProbe({ probePortHolder: async () => { throw new Error("lsof: command not found"); } });
    await expect(
      bindApiServerWithRetry(() => { throw eaddrinuse(); }, d),
    ).rejects.toBeInstanceOf(ApiPortInUseError);
  });

  test("a successful bind never probes", async () => {
    const d = depsWithProbe();
    await bindApiServerWithRetry(() => "server" as any, d);
    expect(d.probeCalls.length).toBe(0);
  });
});
```

Also update the OLD test that currently asserts the raw-error message (it now gets a differently-shaped, but still EADDRINUSE-mentioning, error):

Find this existing test:

```ts
  test("exhausting retries rethrows the original error after exactly BIND_RETRY_ATTEMPTS calls", async () => {
    const d = deps();
    let calls = 0;
    await expect(
      bindApiServerWithRetry(() => { calls++; throw eaddrinuse(); }, d),
    ).rejects.toThrow("EADDRINUSE");
    expect(calls).toBe(BIND_RETRY_ATTEMPTS);
    expect(d.sleeps.length).toBe(BIND_RETRY_ATTEMPTS - 1);
  });
```

Change its assertion to also cover the new type, since `deps()` (the original helper, with no `probePortHolder` override) must still work by falling back to a default real-`lsof` probe — which would actually shell out in a test. To keep this test hermetic, add `probePortHolder: async () => "n/a"` to the base `deps()` helper's return object (it is an optional field on `BindRetryDeps`, so this is a backward-compatible addition, not a signature break):

```ts
function deps(overrides: Partial<BindRetryDeps> = {}): BindRetryDeps & { logs: string[]; sleeps: number[] } {
  const logs: string[] = [];
  const sleeps: number[] = [];
  return {
    sleep: async (ms: number) => { sleeps.push(ms); },
    log: { warn: (_o: unknown, m: string) => logs.push(`warn:${m}`) },
    probePortHolder: async () => "n/a",
    logs,
    sleeps,
    ...overrides,
  };
}
```

Then the pre-existing test's assertion becomes:

```ts
  test("exhausting retries rethrows as ApiPortInUseError after exactly BIND_RETRY_ATTEMPTS calls", async () => {
    const d = deps();
    let calls = 0;
    await expect(
      bindApiServerWithRetry(() => { calls++; throw eaddrinuse(); }, d),
    ).rejects.toThrow("EADDRINUSE");
    expect(calls).toBe(BIND_RETRY_ATTEMPTS);
    expect(d.sleeps.length).toBe(BIND_RETRY_ATTEMPTS - 1);
  });
```

(only the test name and this doc comment change; `.rejects.toThrow("EADDRINUSE")` still matches since `ApiPortInUseError`'s message contains that substring.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/daemon/__tests__/api-server-bind.test.ts`
Expected: FAIL — `ApiPortInUseError` not exported; `probePortHolder` not a recognized field yet.

- [ ] **Step 3: Write minimal implementation**

In `lib/daemon/api-server.ts`, add the import:

```ts
import { runCapture } from "../subprocess.ts";
```

Add the error class and update `BindRetryDeps`/`bindApiServerWithRetry`. Replace the current block:

```ts
export interface BindRetryDeps {
  sleep: (ms: number) => Promise<void>;
  log: { warn: (o: unknown, m: string) => void };
}

// evictStaleDaemon (lib/daemon/boot-reconcile.ts) already assumes a prior
// holder is gone after a 300ms Bun.sleepSync — 6 attempts at 500ms (~3s
// worst case, exported so tests assert against these, not hardcoded copies)
// gives that same assumption room to be wrong once before this gives up too.
export const BIND_RETRY_ATTEMPTS = 6;
export const BIND_RETRY_DELAY_MS = 500;

/**
 * evictStaleDaemon() SIGTERMs the previous holder of this port before a new
 * daemon binds, but the kill isn't synchronous with the exit — a fresh
 * daemon can reach this bind before the old one has actually released
 * 9401. Only EADDRINUSE is retried (bounded, ~3s total); anything else is a
 * real misconfiguration and fails on the first attempt, same as before.
 */
export async function bindApiServerWithRetry<T>(bind: () => T, deps: BindRetryDeps): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return bind();
    } catch (err) {
      const isAddrInUse = err instanceof Error && (err as NodeJS.ErrnoException).code === "EADDRINUSE";
      if (!isAddrInUse || attempt >= BIND_RETRY_ATTEMPTS) throw err;
      deps.log.warn({ attempt, port: API_PORT }, "api port in use, retrying — another daemon is likely still shutting down");
      await deps.sleep(BIND_RETRY_DELAY_MS);
    }
  }
}
```

with:

```ts
/**
 * Thrown when every bind retry is exhausted with EADDRINUSE still held. A
 * NAMED error type (S043) rather than the raw EADDRINUSE Error, so
 * lib/daemon.ts's caller can distinguish "the port is genuinely squatted"
 * from any other startup failure and park-and-retry with backoff instead of
 * crash-looping (that caller-side change belongs to a sibling job; this
 * class is the contract it wires into).
 */
export class ApiPortInUseError extends Error {
  readonly code = "EADDRINUSE" as const;
  readonly port: number;
  constructor(port: number) {
    super(`EADDRINUSE: api server port ${port} is still in use after ${BIND_RETRY_ATTEMPTS} bind attempts`);
    this.name = "ApiPortInUseError";
    this.port = port;
  }
}

export interface BindRetryDeps {
  sleep: (ms: number) => Promise<void>;
  log: { warn: (o: unknown, m: string) => void };
  /** Defaults to a real `lsof -i :<port>` via runCapture; overridable so tests never shell out. */
  probePortHolder?: (port: number) => Promise<string>;
}

async function defaultProbePortHolder(port: number): Promise<string> {
  const result = await runCapture(["lsof", "-i", `:${port}`], { timeoutMs: 5_000, stderr: "pipe" });
  return result.stdout.trim();
}

// evictStaleDaemon (lib/daemon/boot-reconcile.ts) already assumes a prior
// holder is gone after a 300ms Bun.sleepSync — 6 attempts at 500ms (~3s
// worst case, exported so tests assert against these, not hardcoded copies)
// gives that same assumption room to be wrong once before this gives up too.
export const BIND_RETRY_ATTEMPTS = 6;
export const BIND_RETRY_DELAY_MS = 500;

/**
 * evictStaleDaemon() SIGTERMs the previous holder of this port before a new
 * daemon binds, but the kill isn't synchronous with the exit — a fresh
 * daemon can reach this bind before the old one has actually released
 * 9401. Only EADDRINUSE is retried (bounded, ~3s total); anything else is a
 * real misconfiguration and fails on the first attempt, same as before.
 *
 * Once retries are exhausted, this logs WHO holds the port (S043's
 * diagnostic ask) and throws ApiPortInUseError instead of the bare
 * EADDRINUSE Error, so a caller can tell "give up cleanly" apart from "the
 * bind function itself is broken".
 */
export async function bindApiServerWithRetry<T>(bind: () => T, deps: BindRetryDeps): Promise<T> {
  const probe = deps.probePortHolder ?? defaultProbePortHolder;
  for (let attempt = 1; ; attempt++) {
    try {
      return bind();
    } catch (err) {
      const isAddrInUse = err instanceof Error && (err as NodeJS.ErrnoException).code === "EADDRINUSE";
      if (!isAddrInUse) throw err;
      if (attempt >= BIND_RETRY_ATTEMPTS) {
        const holder = await probe(API_PORT).catch((probeErr) => `lsof failed: ${String(probeErr)}`);
        deps.log.warn({ port: API_PORT, holder }, "api port still in use after retries; giving up bind — the daemon should park and retry with backoff rather than crash-loop");
        throw new ApiPortInUseError(API_PORT);
      }
      deps.log.warn({ attempt, port: API_PORT }, "api port in use, retrying — another daemon is likely still shutting down");
      await deps.sleep(BIND_RETRY_DELAY_MS);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/daemon/__tests__/api-server-bind.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full daemon test slice and tsc**

Run: `bun test lib/daemon`
Run: `bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/api-server.ts lib/daemon/__tests__/api-server-bind.test.ts
git commit -m "daemon: log the EADDRINUSE port holder and throw a typed ApiPortInUseError (S043)"
```

---

## Task 9: git-ref validation utility (S010 — standalone, sibling wires it into worktree.ts)

**Files:**
- Create: `lib/daemon/git-ref-validation.ts`
- Test: `lib/daemon/__tests__/git-ref-validation.test.ts`

**Interfaces:**
- Produces: `export function isSafeGitRef(ref: string): boolean` and `export function validateGitRef(ref: string): { ok: true } | { ok: false; error: string }`.

This module is NOT wired into `lib/daemon/handlers/worktree.ts` by this job — that file is sibling-owned per the write fence. The wiring is documented in `docs/daemon-api-auth.md` (Task 11) and the job report's Notes.

- [ ] **Step 1: Write the failing test**

```ts
// lib/daemon/__tests__/git-ref-validation.test.ts
import { describe, test, expect } from "bun:test";
import { isSafeGitRef, validateGitRef } from "../git-ref-validation.ts";

describe("isSafeGitRef", () => {
  test("a normal branch name is safe", () => {
    expect(isSafeGitRef("feature/my-branch")).toBe(true);
  });

  test("a leading dash is unsafe (option injection, S010)", () => {
    expect(isSafeGitRef("--upload-pack=touch /tmp/x")).toBe(false);
  });

  test("a bare dash is unsafe", () => {
    expect(isSafeGitRef("-")).toBe(false);
  });

  test("an empty string is unsafe", () => {
    expect(isSafeGitRef("")).toBe(false);
  });

  test("a branch containing a dash mid-name is safe", () => {
    expect(isSafeGitRef("job/p3-trust-boundary")).toBe(true);
  });
});

describe("validateGitRef", () => {
  test("returns ok:true for a safe ref", () => {
    expect(validateGitRef("main")).toEqual({ ok: true });
  });

  test("returns ok:false with the offending ref named in the error for an unsafe one", () => {
    const result = validateGitRef("--upload-pack=x");
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("--upload-pack=x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/daemon/__tests__/git-ref-validation.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/daemon/git-ref-validation.ts
/**
 * Rejects a branch/ref that could be parsed by git as an OPTION rather than
 * a ref (S010): a caller-supplied `branch` like "--upload-pack=touch /tmp/x"
 * reaches `git fetch origin <branch>` and `git rev-list ...<branch>...`
 * unescaped in lib/daemon/handlers/worktree.ts, and git happily runs it as
 * an option since nothing on that path validates the string first. This is
 * the ONE guard both call sites need; a future caller (or a consumer app
 * like mr-board/console/the chat viewer forwarding an untrusted string as
 * `branch`) inherits the same hole without it.
 *
 * Deliberately narrow: reject a leading '-' rather than allowlisting a
 * character set, since `git check-ref-format --branch` accepts far more
 * punctuation than is worth re-deriving here, and the vulnerable shape is
 * specifically "parses as an option", not "contains an unusual character".
 */
export function isSafeGitRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith("-");
}

export function validateGitRef(ref: string): { ok: true } | { ok: false; error: string } {
  if (!isSafeGitRef(ref)) {
    return { ok: false, error: `unsafe git ref (starts with '-' or empty): ${ref}` };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/daemon/__tests__/git-ref-validation.test.ts`
Expected: PASS

- [ ] **Step 5: Run tsc**

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/git-ref-validation.ts lib/daemon/__tests__/git-ref-validation.test.ts
git commit -m "daemon: standalone git-ref validator for S010 (worktree.ts wiring documented, not wired here)"
```

---

## Task 10: credential redaction utility (S050 — standalone, sibling wires it into freshness.ts)

**Files:**
- Create: `lib/daemon/redact-credentials.ts`
- Test: `lib/daemon/__tests__/redact-credentials.test.ts`

**Interfaces:**
- Produces: `export function redactCredentials(text: string): string`.

Same treatment as Task 9: `lib/daemon/freshness.ts` (where the audit's fixer notes say this belongs, at lines ~142/148/275/279) is not in this job's write fence. This module is standalone and tested; the wiring is documented in `docs/daemon-api-auth.md` (Task 11) and the report's Notes.

- [ ] **Step 1: Write the failing test**

```ts
// lib/daemon/__tests__/redact-credentials.test.ts
import { describe, test, expect } from "bun:test";
import { redactCredentials } from "../redact-credentials.ts";

describe("redactCredentials", () => {
  test("redacts userinfo (user:token@) out of an https remote URL", () => {
    const input = "https://oauth2:glpat-XXXXXXXXXXXXXXXXXXXX@gitlab.example.com/g/p.git";
    const out = redactCredentials(input);
    expect(out).not.toContain("glpat-XXXXXXXXXXXXXXXXXXXX");
    expect(out).toContain("gitlab.example.com/g/p.git");
  });

  test("redacts a GitHub PAT embedded in the URL", () => {
    const input = "https://ghp_abcdefghijklmnopqrstuvwxyz012345@github.com/o/r.git";
    const out = redactCredentials(input);
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    expect(out).toContain("github.com/o/r.git");
  });

  test("leaves a URL with no embedded credentials unchanged", () => {
    const input = "https://gitlab.example.com/g/p.git";
    expect(redactCredentials(input)).toBe(input);
  });

  test("leaves plain text with no URL unchanged", () => {
    const input = "local branch listing failed";
    expect(redactCredentials(input)).toBe(input);
  });

  test("redacts every match when more than one credential-bearing URL appears in the same string", () => {
    const input = "tried https://oauth2:tok1@a.example/x then https://oauth2:tok2@b.example/y";
    const out = redactCredentials(input);
    expect(out).not.toContain("tok1");
    expect(out).not.toContain("tok2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/daemon/__tests__/redact-credentials.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/daemon/redact-credentials.ts
/**
 * Strips userinfo (user:token@ or user@) out of any http(s) URL embedded in
 * a string (S050): freshness.ts logs `remote.origin.url` verbatim at info
 * on every reconcile, and echoes it into thrown errors every mr/discussions
 * handler returns to callers. A repo cloned as
 * `https://oauth2:glpat-XXXX@gitlab.example.com/...` (routine for
 * dotfiles/CI-derived clones) puts that token into ~/.rt/logs/daemon.*.log
 * and into any client-facing error message -- logs are the first thing a
 * user pastes into a bug report.
 */
const CREDENTIAL_URL_RE = /(https?:\/\/)[^/@\s]+@/gi;

export function redactCredentials(text: string): string {
  return text.replace(CREDENTIAL_URL_RE, "$1[redacted]@");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/daemon/__tests__/redact-credentials.test.ts`
Expected: PASS

- [ ] **Step 5: Run tsc**

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/redact-credentials.ts lib/daemon/__tests__/redact-credentials.test.ts
git commit -m "daemon: standalone credential-redaction utility for S050 (freshness.ts wiring documented, not wired here)"
```

---

## Task 11: docs note + final whole-branch verification

**Files:**
- Create: `docs/daemon-api-auth.md`

- [ ] **Step 1: Write the doc**

```markdown
# The :9401 trust boundary

How the daemon's REST/WS surface decides who to trust, and the follow-up
wiring two standalone modules from this phase still need in sibling-owned
files.

## The model

- **No `Origin` header at all** (the CLI, the Swift tray, rt-client from a
  Bun/Node process, mr-board, gitq, the VS Code extension): unaffected, no
  gate applies beyond what already existed. None of today's consumers send
  an `Origin` header to `:9401`.
- **A browser `Origin` header is present**: trusted only if the request
  presents the local `X-RT-Token` (`?token=` query param for `/ws`, since
  browsers cannot set custom headers on a WS handshake) OR the Origin is on
  the `rt.trustedBrowserOrigins` settings allowlist (see
  `packages/rt-client/src/settings/registry-defs.ts`; `docs/settings-architecture.md`
  is the settings-system contract). Otherwise: no `Access-Control-Allow-Origin`
  on REST reads (default-deny CORS), and a 403 on `/ws`.
- **Mutating routes** (every method except GET/HEAD/OPTIONS, plus
  `/api/secrets` and `/api/notifications` despite being GETs) require the
  local `X-RT-Token` regardless of Origin — this is the CSRF defense against
  a browser form/simple-request bypassing CORS preflight entirely, and it is
  orthogonal to the Origin check above.

See `lib/daemon/api-auth.ts` (`isBrowserRequestTrusted`, `needsToken`,
`getTrustedBrowserOrigins`) and `lib/daemon/api-server.ts`
(`buildCorsHeaders`, the `/ws` gate in `fetch()`) for the implementation.

## Follow-up wiring for sibling-owned files (not done in this job)

**S010** (`lib/daemon/handlers/worktree.ts`): `lib/daemon/git-ref-validation.ts`
exports `validateGitRef(ref)`. Call it right after `payload.branch` is read
(around `worktree.ts:282`) and return `{ ok: false, error }` on a rejection
BEFORE any `runGit` call reaches it — that single call site also covers the
weaker secondary instance in `divergence()` (`worktree.ts:211-213`), since
both read the same `branch` value.

**S050** (`lib/daemon/freshness.ts`): `lib/daemon/redact-credentials.ts`
exports `redactCredentials(text)`. Wrap every log/error interpolation of a
remote URL with it — the audit names `freshness.ts:142, 148, 275, 279` as the
current call sites.

**S043 caller side** (`lib/daemon.ts`): `lib/daemon/api-server.ts` exports
`ApiPortInUseError` (a named `Error` subclass with `.name === "ApiPortInUseError"`
and `.port`). Catch it around the `startApiServer()` call and park-and-retry
with backoff instead of letting it reach the top-level crash path; any other
error out of `startApiServer()` is a genuine misconfiguration and should keep
crashing as it does today.
```

- [ ] **Step 2: Run the full verification suite**

Run: `bun test lib commands packages scripts`
Expected: all green.

Run: `bunx tsc --noEmit`
Expected: zero errors.

Run: `cd packages/rt-client && bun run build && cd -`
Expected: clean build (already run in Task 3, but re-run here as the final gate since later tasks may have touched files rt-client's dist-freshness test watches).

- [ ] **Step 3: Commit**

```bash
git add docs/daemon-api-auth.md
git commit -m "docs: the :9401 trust boundary model and the S010/S050/S043 sibling wiring notes"
```

---

## Self-Review Notes (already applied above)

- **Spec coverage:** S092 (Task 1), S054 (Task 2), S005/S006/S040/S041/S084 (Tasks 3-4), S042 (Task 5), S083 (Task 6), S085 (Task 7), S043 (Task 8), S010 (Task 9), S050 (Task 10). All 13 cited findings have a task.
- **Write fence:** every modified/created file is inside the job's write fence; Tasks 9-10 deliberately stop short of editing `worktree.ts`/`freshness.ts` and document the wiring instead, mirroring the job brief's explicit instruction for S010 and extending the same treatment to S050 since its fix location is equally out of fence.
- **Type consistency:** `isBrowserRequestTrusted(origin, token, apiToken, allowedOrigins)` has the same parameter order and names everywhere it's used (Task 3 definition, Task 4 call sites). `BroadcastTarget`/`broadcastToClients` names match between Task 5's definition and its test. `pathParam`/`coerceQueryParams` signatures match between definition and test across Tasks 6-7.
