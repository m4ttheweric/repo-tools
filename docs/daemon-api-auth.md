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
  local `X-RT-Token` regardless of Origin... this is the CSRF defense against
  a browser form/simple-request bypassing CORS preflight entirely, and it is
  orthogonal to the Origin check above.

See `lib/daemon/api-auth.ts` (`isBrowserRequestTrusted`, `needsToken`,
`getTrustedBrowserOrigins`) and `lib/daemon/api-server.ts`
(`buildCorsHeaders`, the `/ws` gate in `fetch()`) for the implementation.

## Follow-up wiring for sibling-owned files (not done in this job)

**S010** (`lib/daemon/handlers/worktree.ts`): `lib/daemon/git-ref-validation.ts`
exports `validateGitRef(ref)`. Call it right after `payload.branch` is read
(around `worktree.ts:282`) and return `{ ok: false, error }` on a rejection
BEFORE any `runGit` call reaches it... that single call site also covers the
weaker secondary instance in `divergence()` (`worktree.ts:211-213`), since
both read the same `branch` value.

**S050** (`lib/daemon/freshness.ts`): `lib/daemon/redact-credentials.ts`
exports `redactCredentials(text)`. Wrap every log/error interpolation of a
remote URL with it... the audit names `freshness.ts:142, 148, 275, 279` as the
current call sites.

**S043 caller side** (`lib/daemon.ts`): `lib/daemon/api-server.ts` exports
`ApiPortInUseError` (a named `Error` subclass with `.name === "ApiPortInUseError"`
and `.port`). Catch it around the `startApiServer()` call and park-and-retry
with backoff instead of letting it reach the top-level crash path; any other
error out of `startApiServer()` is a genuine misconfiguration and should keep
crashing as it does today.

## Known gap: GET routes that trigger real work stay ungated

`GET /api/cache?maxAgeMs=<n>` can force a full cache refresh, and
`GET /api/sdm/recents` spawns `sdm status`; neither requires the local token.
Default-deny CORS stops an untrusted browser Origin from reading the
response, but a plain cross-origin GET needs no preflight, so the request
still lands and the work still runs even when the response is unreadable.
This is deliberately not fixed here: gating these routes risks breaking
non-browser REST consumers that read them untokened today (the tray,
editor extensions), and there was no time in this pass to audit every such
consumer, which the audit's own fixer notes flag as the real risk of
tokening reads. Tracked as an open follow-up, not a silently-closed finding.
