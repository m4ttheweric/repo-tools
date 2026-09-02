# rt setup verbs (L1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give mattstack.app (and the terminal) the rt verbs behind the installer: a readiness plan computed from real validators, an NDJSON apply stream of idempotent install steps, team create/join/invite/publish with opaque relay invites, bundled-tool resolution and tagged PATH links, team-scope secrets, services/permissions facades over tray.sock, uninstall, and a thin `rt update` — with `rt verify` running the very same validators.

**Architecture:** Everything new lives in `lib/setup/` (contract types, probes seam, validators, plan composition, apply engine + steps, need protocol, uninstall), `lib/team/` (create/publish/invite/join/members, invite crypto, relay client), `lib/deps/` (bundled-tool resolution + tagged links), `lib/secrets/team-store.ts` (N-recipient team secrets), and thin command modules (`commands/setup.ts`, `team.ts`, `deps.ts`, `repos.ts`, `skills.ts`, `cron.ts`, `tools.ts`, `services.ts`, `uninstall.ts`). Every external effect (exec, fs, fetch, tray.sock, daemon) goes through one injectable `Probes` seam so every unit test runs with fakes; the real seam is assembled once in `lib/setup/probes.ts`. The JSON contract (`2026-08-21-rt-setup-contract.md`) is implemented byte-for-byte by `lib/setup/contract.ts` and pinned by tests.

**Tech Stack:** Bun/TypeScript; `@mattstack/rt-client` settings module (`getSetting`/`setSetting`, suite registry); `lib/secrets/store.ts` (sops/age); WebCrypto AES-256-GCM (Bun) for invite pointers; `gh`/`glab`/`git`/`claude`/`herdr`/`sops` CLIs behind the exec seam; tray.sock over `fetch({unix})`.

**Amendment A1 (2026-08-21, binding before Task 1):** the home repo is re-rooted — `~/.mattstack/user/` IS the repo (settings.user.jsonc, user/local/<machine-key>/, secrets/ relative to the repo root, teams/<name>/mattstack/settings.team.jsonc); `rt home init` clones into `user/` and writes `~/.mattstack/machine-key`. Every task below that names a home-repo path reads through the rt50b spec `docs/superpowers/specs/2026-08-21-home-repo-reroot.md`; the controller ledgers the per-task path deltas at pre-flight. See spec Amendment A1.

**Spec:** `docs/superpowers/specs/2026-08-20-mattstack-app-installer-design.md` (§4.3/4.4/5.2/5.3/5.3b/6/7/9/10/12.3/13) and the binding contract `docs/superpowers/specs/2026-08-21-rt-setup-contract.md`. Settings substrate: `docs/superpowers/specs/2026-08-20-suite-settings-migration.md`, `docs/superpowers/plans/2026-08-20-home-repo-foundation.md`, the in-flight keys wave (`repo-tools-rt50b-wt/docs/superpowers/plans/2026-08-20-rt-keys-wave.md`), and `~/.mattstack/user/local/reply-2026-08-20-settings-lane-to-installer.md`.

**Execution order (cross-plan):** this plan is one of four lanes (L1 this, L3 app shell, L4 release pipeline, L7 clean-room VM); the binding phase/merge order is `docs/superpowers/plans/2026-08-21-cross-plan-review.md` §3. For L1: **Phase A** (no cross-lane dependency) = Tasks 1–4, 6, 9, 13–19. **Phase B** = Task 5 AFTER L4 T1 + T9 merge (consumes `lib/bundle-layout.ts`, `installRtBinary`, `installedTrayAppPath`); Tasks 7, 8, 10, 11, 21 AFTER L1 T5 and L4 T11 (`resolveFzf`) merge; Task 22 implements the `/setup/need` reply protocol exactly as L3 T9 / the contract state it; Tasks 24 and 27 AFTER L4 T9 merge (`bundleRootFromExec`, `installRtBinary`, `legacyUserAppPath`); Task 30 is independent (L4's competing `rt update` edit is dropped); Task 31 AFTER L4 T12 merge (README/docs are L4's). Merge order to main: L4 phase A → L3 T1–T11 → L1 T1–T4, T6, T9, T13–T19 → L4 T4/T5/T8 → L1 T5, T7–T12, T20–T30 → L3 T12–T19 → L7 → L4 T12 → L1 T31–T32 → MATT gates.

## Global Constraints

Copied from the spec's invariants (§2 "Invariants") and the lane rules — every task's requirements include these:

- **No user or employer data ever lands on mattstack-hosted infrastructure.** The shared relay sees ciphertext and timestamps only; pointers are encrypted client-side; no plaintext field is ever posted.
- **rt owns mechanics, the app owns ceremony; every ceremony has a CLI equivalent.** The wizard never does something `rt setup` cannot.
- **Honesty over magic:** every checklist row reports what was actually checked; nothing is marked ready on a guess. A probe that cannot run reports `error`/`checking`, never `ready`.
- **Settings are read and written only through `@mattstack/rt-client`'s settings module** (`getSetting`/`setSetting`/`listTeams` via the `lib/settings/*` barrels); state only through each app's state.db / `~/.mattstack/rt` runtime files. rt never parses a store file by hand.
- **The installer never copies a user's `~/.claude/settings.json` or hooks; it adds marketplaces and plugins only** (and never edits `~/.claude.json`).
- **Pure canonical, no compat:** `rt-tray.app`, `com.rt.daemon`, `~/.rt`, brew paths are swept, never honored.
- **`~/.mattstack` is the home repo** (gitignore is the layer boundary); team clones nest under `~/.mattstack/teams/<slug>/`; runtime under `~/.mattstack/rt/`.
- **Clean-code comments:** a comment only states a constraint the code cannot show; no narration, no task/ticket references, no review/decision history in source.
- Contract fidelity: JSON shapes, step ids, statuses, action types, exit codes (`0` ok · `2` user-actionable `{error}` · `1` bug), envelope `{contract:1, at}` exactly as the contract file states. Secrets (tokens, invite codes) travel on stdin or env, never argv.
- Every new `module:` in `lib/command-tree-def.ts` gets its `lib/module-registry.ts` import + entry **in the same commit** (`lib/__tests__/module-registry.test.ts` enforces it).
- Tests: bunfig preload repoints HOME (never remove); tests never touch the real HOME, keychain, network, tray.sock, or daemon — every seam is injectable; any spawn passes `env: process.env` (Bun PATH-snapshot gotcha).
- **NO monitor exists. Implementers run the tests themselves** (`bun test lib commands packages`, `bun x tsc --noEmit`), never wait for results to arrive.
- Worktree `/Users/matt/Documents/GitHub/repo-tools-l1-wt`, branch `goodwinmattheweric/mat-383-rt-setup-verbs` off `origin/main`. The settings lane lands more on main overnight (keys wave, H2 snapshot daemon, R restore, deck/board/gitq lanes): **rebase onto `origin/main` before every merge** (Task 0 and Task 33 say how), and **rebase onto `origin/main` after L4 T1/T9/T11 merge before starting Tasks 5/7/24/27**. Never touch the main checkout.
- **File ownership (cross-plan review §1):** `commands/verify.ts`, `commands/update.ts`, `cli.ts`, `commands/post-install.ts` are L1's — no other lane edits them. `README.md` is L4's (L1 does not edit it). `lib/rt-paths.ts`, `lib/dev-mode.ts`, `lib/fzf.ts`, `lib/notifier.ts`, `lib/bundle-layout.ts` are L4's — L1 consumes their exports (`appBundleRoot`, `bundleRootFromExec`, `bundledHelperPath`, `bundledExec`, `RT_BUNDLE_PATH`, `installRtBinary`, `installedTrayAppPath`, `legacyUserAppPath`, `resolveFzf`) and never edits them. `rt-tray/**` is L3's/L4's. Spec and contract files (`docs/superpowers/specs/*`) are edited only in the appspec branch, never committed from this worktree.
- Commit messages prefixed `MAT-383:`; every commit ends with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- ORCHESTRATOR-ONLY tasks (marked) need the live machine (real tray.sock, keychain, gh auth); implementer subagents never run them.

---

## File structure (locked)

```
lib/setup/
  contract.ts          Plan/Row/Action/ApplyEvent types, CONTRACT_VERSION, envelope(), finalizePlan(), rowStatusRank
  errors.ts            UserActionableError + exitUserError(json) → exit 2
  emit.ts              Emit type; stdout NDJSON emitter; human emitter for TTY
  probes.ts            Probes seam (exec/fs/fetch/tray/daemon/env) + createRealProbes()
  intent.ts            setup-intent.json (runtime, 0600): mode + team/join/restore inputs
  staging.ts           staged secrets before the age key exists (rt/setup-staging/*.json, 0600)
  state.ts             setup-state.json: what apply installed (plugins, marketplaces, links, editors)
  requirements.ts      pack-side requirements.jsonc reader (tools/integrations/why)
  integrations.ts      per-integration connect/validate table (fields, secret domain/key, validator)
  permissions.ts       GET /permissions → perm.* rows
  validators/mac.ts    perm.*, tool.macos, tool.clt, tool.path
  validators/rt-health.ts  tool.rt, tool.legacy-dirs, tool.intercepts, tool.fzf, tool.app, tool.extension, tool.shell, tool.daemon
  validators/tools.ts  tool.herdr, tool.claude, tool.fast-browser, tool.editor, tool.chrome, tool.mission-control, team tools, pack.*
  validators/accounts.ts account.* rows (+ owner-once slack-app, switchboard)
  validators/access.ts access.* rows
  plan.ts              composePlan(): groups in order, merges permissions, finalizePlan
  need.ts              awaitNeed(): the need-event wait over tray.sock
  apply.ts             runApply(): engine (plan event, --from resume, stop-on-fail, done)
  steps/index.ts       ordered StepDef[] (contract step ids)
  steps/home.ts steps/team.ts steps/secrets.ts steps/path.ts steps/settings.ts steps/repos.ts
  steps/services.ts steps/deck.ts steps/skills.ts steps/plugins.ts steps/tools.ts steps/verify.ts
  uninstall.ts         computeUninstallActions() + runUninstall()
  slack-app.ts         manifest generation + app creation via Slack API
  tools-install.ts     brew|vendor|apple-clt installs; tool-owned setup wrappers
  __tests__/fakes.ts   fakeProbes(), FakeTray, recorded exec scripts
lib/deps/
  resolve.ts           appBundlePath() (= L4 appBundleRoot), bundledToolPath(), bundledToolExec(), userCopyOnPath(), resolveTool()
  links.ts             tagged links (symlink or "# mattstack-link:" wrapper): isOurLink(), link(), unlink(), reconcile(), DEFAULT_EXPOSED
lib/team/
  slug.ts              slugify()
  invite-crypto.ts     AES-256-GCM seal/open, code encode/decode (base32 crockford)
  relay-client.ts      POST/GET/redeem/reply/DELETE /v1/invites
  create.ts            scaffold team zone + remote (+ gh repo create)
  publish.ts           push / set-url
  invite.ts            mint: pointer, forge grant, roster, code, paste block
  join.ts              dry-run + redeem + clone + reply blob + peering
  members.ts           sync (collect reply keys → recipients) / remove (ACL revoke + rotate)
  forge.ts             forge grant/revoke via gh/glab api
lib/secrets/team-store.ts   teams/<slug>/mattstack/secrets/<domain>.json, N-recipient .sops.yaml
commands/setup.ts commands/team.ts commands/deps.ts commands/repos.ts commands/skills.ts
commands/cron.ts commands/tools.ts commands/services.ts commands/uninstall.ts
commands/update.ts (rewritten thin) commands/verify.ts (refactored) commands/post-install.ts (entry only)
lib/daemon-client.ts (+ traySocketPath(), trayRequest())
lib/command-tree-def.ts + lib/module-registry.ts (every new module)
```

## Conventions every task follows

- Verbs that emit JSON accept `--json`; without it they print human lines via `lib/tui.ts` colors. JSON results are `envelope({...})`. Streaming verbs write one `JSON.stringify(ev)` per line to stdout, nothing else on stdout.
- A user-actionable failure throws `UserActionableError(code, message, extra?)`; the command's top level catches it and calls `exitUserError(err, json)` → prints `envelope({ error: { code, message, ...extra } })` (JSON) or `rt <verb>: <message>` (human) and `process.exit(2)`. Anything else propagates (exit 1 via the CLI crash seam).
- Command functions take `(args: string[], ctx: CommandContext = {}, deps = realDeps())` so tests call them directly with fakes; tests assert on a captured `print` seam, never on console.
- Secrets and invite codes: read from stdin (`readStdinJson()` in `lib/setup/probes.ts`) or a no-echo prompt (reuse `promptSecretValue` pattern from `commands/secrets.ts`, exported from a shared helper `lib/setup/prompt-secret.ts` created in Task 1).

---

### Task 0 (ORCHESTRATOR-ONLY): worktree + branch

- [ ] `cd /Users/matt/Documents/GitHub/repo-tools && git fetch origin && git worktree add -b goodwinmattheweric/mat-383-rt-setup-verbs /Users/matt/Documents/GitHub/repo-tools-l1-wt origin/main && cd /Users/matt/Documents/GitHub/repo-tools-l1-wt && bun install`
- [ ] Baseline: `bun x tsc --noEmit` → 0 errors; `bun test lib commands packages` green. Record which of these are already on main (it changes overnight): `grep -n '"rt.cron"\|"rt.repoTracking"' -A6 packages/rt-client/src/settings/registry-defs.ts | grep migrated`, `ls commands/restore.ts lib/daemon/snapshot* 2>/dev/null`. Steps that depend on them (Task 21 `cron install`, Task 25 `home.restore`) carry honest guards, so nothing blocks on the answer.
- [ ] Rebase rule for every later merge checkpoint: `git fetch origin && git rebase origin/main`, rerun both gates, fix conflicts in this branch only.

---

### Task 1: Contract types, envelope, errors, emitters, secret prompt

**Files:**
- Create: `lib/setup/contract.ts`, `lib/setup/errors.ts`, `lib/setup/emit.ts`, `lib/setup/prompt-secret.ts`
- Test: `lib/setup/__tests__/contract.test.ts`, `lib/setup/__tests__/emit.test.ts`
- Modify: `commands/secrets.ts` (import `promptSecretValue` from the new helper instead of its private copy; behavior unchanged)

**Interfaces:**
- Produces (all later tasks consume):

```ts
// lib/setup/contract.ts
export const CONTRACT_VERSION = 1 as const;
export type RowStatus = "ready" | "missing" | "invalid" | "needs-you" | "checking" | "skipped" | "error";
export type RowKind = "permission" | "tool" | "account" | "access" | "info";
export type Recheck = "on-activate" | "on-change" | "manual";
export type GroupId = "mac" | "accounts" | "access" | "tools";
export type Integration = "github" | "gitlab" | "linear" | "slack" | "switchboard" | "sdm" | "doppler" | "ldcli";
export interface ConnectField { name: string; label: string; secret: boolean; hint?: string }
export type Action =
  | { type: "open-settings"; label: string; target: "fda" | "login-items" | "notifications" | "keyboard" }
  | { type: "request-permission"; label: string; which: "notifications" }
  | { type: "connect"; label: string; integration: Integration; fields: ConnectField[]; alternatives?: { id: string; label: string }[] }
  | { type: "oauth"; label: string; integration: Integration; verb: string[] }
  | { type: "owner-once"; label: string; integration: Integration; fields: ConnectField[] }
  | { type: "install"; label: string; tool: string; via: "brew" | "vendor" | "apple-clt" | "bundled-link" }
  | { type: "link-bundled"; label: string; tool: string }
  | { type: "steps"; label: string; steps: string[] }
  | { type: "open-url"; label: string; url: string }
  | { type: "run"; label: string; verb: string[] };
export interface Row { id: string; kind: RowKind; title: string; why: string; required: boolean; optionalNote: string | null; status: RowStatus; detail: string; action: Action | null; recheck: Recheck }
export interface Group { id: GroupId; title: string; rows: Row[] }
export type TeamMode = "join" | "create" | "restore" | "none";
export interface TeamRef { slug: string; name: string; mode: TeamMode }
export interface Plan { contract: 1; at: string; team: TeamRef; groups: Group[]; canInstall: boolean; requiredMissing: string[] }
export const GROUP_TITLES: Record<GroupId, string> = { mac: "Your Mac", accounts: "Accounts", access: "Access", tools: "Tools" };
export type StepKind = "rt" | "app" | "privileged";
export type StepState = "pending" | "running" | "done" | "failed" | "skipped";
export const STEP_IDS = ["home.init","home.restore","team.create","team.join","secrets.write","path.link","intercepts.install","settings.seed","repos.clone","services.register","proxy.install","deck.managed","skills.materialize","board.keys","cron.triage","plugins.install","fastbrowser.setup","herdr.integration","extension.install","services.start","snapshot.push","verify"] as const;
export type StepId = (typeof STEP_IDS)[number];
export type NeedRequest =
  | { type: "app-register-services"; plists: string[] }
  | { type: "app-unregister-services"; plists: string[] }
  | { type: "app-privileged"; op: "proxy-install" | "proxy-remove" };
/** Uninstall streams the same event shapes with these ids (contract §uninstall: "NDJSON like apply"). */
export type UninstallActionId = "services.unregister" | "deck.managed-remove" | "proxy.remove" | "path.unlink" | "shell.remove" | "extension.uninstall" | "plugins.uninstall" | "data" | "app.trash";
export type EventId = StepId | UninstallActionId;
export type ApplyEvent =
  | { event: "plan"; steps: { id: EventId; title: string; kind: StepKind }[] }
  | { event: "step"; id: EventId; state: StepState; detail?: string; remedy?: string }
  | { event: "log"; id: EventId; line: string }
  | { event: "need"; id: EventId; request: NeedRequest }
  | { event: "done"; ok: boolean; failedStep?: EventId };
export function envelope<T extends object>(body: T, now: Date = new Date()): T & { contract: 1; at: string } {
  return { contract: CONTRACT_VERSION, at: now.toISOString(), ...body };
}
export function row(r: Omit<Row, "optionalNote" | "action" | "recheck"> & Partial<Pick<Row, "optionalNote" | "action" | "recheck">>): Row {
  return { optionalNote: null, action: null, recheck: "on-change", ...r };
}
/** Install enables only when every required row is ready; requiredMissing lists the others in group order. */
export function finalizePlan(team: TeamRef, groups: Group[], now: Date = new Date()): Plan {
  const requiredMissing = groups.flatMap((g) => g.rows.filter((r) => r.required && r.status !== "ready").map((r) => r.id));
  return envelope({ team, groups, canInstall: requiredMissing.length === 0, requiredMissing }, now);
}
```
`NeedRequest` keeps both uninstall types: L3's NeedBroker must handle `app-unregister-services` and `app-privileged` with `op:"proxy-remove"` (tracked in the cross-plan review §5 #12-13 / #24; the contract lists both).

```ts
// lib/setup/errors.ts
export class UserActionableError extends Error {
  constructor(public readonly code: string, message: string, public readonly extra: Record<string, unknown> = {}) { super(message); }
}
export function userErrorPayload(err: UserActionableError, now = new Date()) {
  return envelope({ error: { code: err.code, message: err.message, ...err.extra } }, now);
}
/** Prints the contract's exit-2 payload (JSON) or a one-line human message, then exits 2. */
export function exitUserError(err: UserActionableError, json: boolean, verb: string, print: (s: string) => void = console.log): never {
  print(json ? JSON.stringify(userErrorPayload(err)) : `rt ${verb}: ${err.message}`);
  process.exit(2);
}
```

```ts
// lib/setup/emit.ts
export type Emit = (ev: ApplyEvent) => void;
export function createNdjsonEmitter(write: (line: string) => void = (l) => process.stdout.write(l)): Emit {
  return (ev) => write(`${JSON.stringify(ev)}\n`);
}
/** TTY rendering of the same stream: one line per step transition, log lines dimmed. */
export function createHumanEmitter(print: (s: string) => void = console.log): Emit {
  const glyph: Record<StepState, string> = { pending: "·", running: "…", done: "✓", failed: "✗", skipped: "–" };
  return (ev) => {
    if (ev.event === "plan") print(`  ${ev.steps.length} steps`);
    else if (ev.event === "step") print(`  ${glyph[ev.state]} ${ev.id}${ev.detail ? `  ${ev.detail}` : ""}${ev.remedy ? `\n      → ${ev.remedy}` : ""}`);
    else if (ev.event === "log") print(`      ${ev.line}`);
    else if (ev.event === "need") print(`  ? ${ev.id} — waiting for mattstack.app (${ev.request.type})`);
    else print(ev.ok ? "  ✓ done" : `  ✗ stopped at ${ev.failedStep}`);
  };
}
```

```ts
// lib/setup/prompt-secret.ts
export function promptSecretValue(message: string): Promise<string>  // moved verbatim from commands/secrets.ts (raw-mode no-echo; rejects when !isTTY)
export async function readStdinJson<T>(): Promise<T | null>           // reads all of stdin, JSON.parse; null on empty; throws UserActionableError("bad-stdin") on parse failure
```

- [ ] **Step 1: Failing tests.** `contract.test.ts`: `finalizePlan` with rows `[required ready, required missing, optional missing]` → `canInstall:false`, `requiredMissing` exactly the required-missing id; all-required-ready → `canInstall:true`, `requiredMissing:[]`; `envelope({x:1}, new Date("2026-08-21T04:00:00Z"))` deep-equals `{contract:1, at:"2026-08-21T04:00:00.000Z", x:1}`; `row({...})` fills `optionalNote:null, action:null, recheck:"on-change"`; `STEP_IDS` equals the contract's 22 ids in order (literal array in the test). `emit.test.ts`: the ndjson emitter writes exactly one line per event and `JSON.parse` round-trips; the human emitter prints a `→ remedy` line for a failed step.
- [ ] **Step 2:** `bun test lib/setup/` → fails (module not found).
- [ ] **Step 3:** Implement the four files as specified; move `promptSecretValue` out of `commands/secrets.ts` (keep `CTRL_C`/`DEL` handling identical) and import it back.
- [ ] **Step 4:** `bun test lib/setup/ commands/` green; `bun x tsc --noEmit` 0.
- [ ] **Step 5: Commit** `MAT-383: setup contract types, envelope, error + NDJSON seams`

---

### Task 2: Probes seam + tray client

**Files:**
- Create: `lib/setup/probes.ts`, `lib/setup/__tests__/fakes.ts`
- Modify: `lib/daemon-client.ts` (add `traySocketPath()`, `trayRequest()`)
- Test: `lib/setup/__tests__/probes.test.ts`, `lib/__tests__/daemon-client-tray.test.ts`

**Interfaces:**
- Produces:

```ts
// lib/daemon-client.ts additions
/** RT_APP_SOCKET (set by the app when it spawns rt) wins over the default tray.sock path. */
export function traySocketPath(): string { return process.env.RT_APP_SOCKET || TRAY_SOCK_PATH; }
export interface TrayReply<T = unknown> { status: number; json: T | null }   // status 0 = socket absent / connection failed / timed out
export async function trayRequest<T = unknown>(path: string, init: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number } = { method: "GET" }): Promise<TrayReply<T>>
export type TrayClient = typeof trayRequest;
```

```ts
// lib/setup/probes.ts
export interface ExecResult { code: number; stdout: string; stderr: string }
export interface Probes {
  /** Never throws: a missing binary yields code 127 with stderr "ENOENT: <argv0>"; timeout yields 124. `inherit` hands the child the TTY (interactive logins) — stdout/stderr then come back empty. */
  exec(argv: string[], opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; input?: string; inherit?: boolean }): Promise<ExecResult>;
  exists(path: string): boolean;
  readFile(path: string): string | null;
  readDir(path: string): string[];
  readlink(path: string): string | null;           // null when not a symlink / missing
  writeFile(path: string, content: string, mode?: number): void;
  removeFile(path: string): void;                  // best-effort
  removeDir(path: string): void;                   // rm -rf semantics, best-effort
  symlink(target: string, path: string): void;
  mkdirp(path: string, mode?: number): void;
  /** Never throws: network failure yields status 0, body "", headers {}. Header names are lowercased. */
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ status: number; body: string; headers: Record<string, string> }>;
  tray: TrayClient;
  daemon(cmd: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<DaemonResponse | null>;
  env: Record<string, string | undefined>;
  home: string;
  now(): Date;
  /** Spawns this same rt (process.execPath) with args; stdin from `input`. Never throws. */
  runRt(args: string[], opts?: { input?: string; timeoutMs?: number }): Promise<ExecResult>;
}
export function createRealProbes(): Probes
```

```ts
// lib/setup/__tests__/fakes.ts
export type ExecScript = (argv: string[], opts?: Parameters<Probes["exec"]>[1]) => ExecResult | Promise<ExecResult>;
export interface FakeProbesOpts { files?: Record<string, string>; dirs?: Record<string, string[]>; links?: Record<string, string>; exec?: ExecScript; fetch?: Probes["fetch"]; tray?: TrayClient; daemon?: Probes["daemon"]; env?: Record<string, string>; home?: string; now?: Date; runRt?: Probes["runRt"] }
export function fakeProbes(opts?: FakeProbesOpts): Probes & { calls: { exec: string[][]; fetch: string[]; tray: string[]; writes: Record<string, string>; removed: string[]; symlinks: Record<string, string> } }
export function fakeTray(routes: Record<string, (body?: unknown) => { status: number; json: unknown }>): TrayClient   // key "GET /permissions"
export const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
export const missing = (bin: string): ExecResult => ({ code: 127, stdout: "", stderr: `ENOENT: ${bin}` });
```

- [ ] **Step 1: Failing tests.** `probes.test.ts`: `createRealProbes().exec(["/nonexistent/bin"])` resolves `{code:127}` (no throw); `exec(["sh","-c","echo hi"])` → `{code:0, stdout:"hi\n"}`; `exec(["sh","-c","sleep 5"],{timeoutMs:100})` → code 124; `fetch("http://127.0.0.1:1")` → `{status:0}`; `fakeProbes({files:{"/a":"x"}}).readFile("/a")==="x"`, `.exists("/b")===false`, `.calls.exec` records argv. `daemon-client-tray.test.ts`: with `process.env.RT_APP_SOCKET="/nonexistent.sock"`, `trayRequest("/health")` → `{status:0,json:null}`; `traySocketPath()` returns the env value; unset → ends with `/.mattstack/rt/tray.sock`.
- [ ] **Step 2:** run, fail.
- [ ] **Step 3: Implement.** Real `exec` uses `Bun.spawn(argv, { cwd, env: { ...process.env, ...opts?.env }, stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" })` in a try/catch (ENOENT → 127), timer kill → 124. `trayRequest` mirrors `trayQuery` but with `body: JSON.stringify(body)` + `Content-Type: application/json`, parses JSON when the response has a body (tolerate non-JSON → `json:null`), catches to `{status:0,json:null}`. `runRt` spawns `process.execPath` with `env: process.env` and `RT_SKIP_SETUP: "1"`.
- [ ] **Step 4:** green; tsc 0. **Step 5: Commit** `MAT-383: probes seam + tray.sock request client`

---

### Task 3: Setup intent, staged secrets, setup state

**Files:**
- Create: `lib/setup/intent.ts`, `lib/setup/staging.ts`, `lib/setup/state.ts`
- Test: `lib/setup/__tests__/intent.test.ts`, `lib/setup/__tests__/staging.test.ts`, `lib/setup/__tests__/state.test.ts`

**Interfaces:**
- Produces:

```ts
// lib/setup/intent.ts  — ~/.mattstack/rt/setup-intent.json (0600; runtime, gitignored)
export interface InvitePointer { v: 1; team: string; name: string; remote: string; owner: string; forge: string; createdAt: string }
export interface SetupIntent {
  v: 1; at: string; mode: "create" | "join" | "restore";
  team?: { slug: string; name: string; remote: string; others: boolean };          // create
  join?: { id: string; keyB64: string; pointer: InvitePointer };                    // join (pointer already decrypted at dry-run)
  restore?: { homeRepo: string };                                                   // restore (age key is never persisted)
}
export function intentPath(home: string): string                                     // join(home, ".mattstack", "rt", "setup-intent.json")
export function readIntent(p: Pick<Probes, "readFile" | "home">): SetupIntent | null // null when absent or unparseable
export function writeIntent(p: Pick<Probes, "writeFile" | "mkdirp" | "home">, intent: SetupIntent): void  // mode 0o600
export function clearIntent(p: Pick<Probes, "removeFile" | "home">): void
export function teamRefFromIntent(intent: SetupIntent | null, teams: string[]): TeamRef
//   create → {slug, name, mode:"create"}; join → {slug: pointer.team, name: pointer.name, mode:"join"}; restore → {slug: teams[0] ?? "", name: teams[0] ?? "", mode:"restore"};
//   null → teams.length ? {slug: teams[0], name: teams[0], mode:"none"} : {slug:"", name:"", mode:"none"}  (multi-team: first alphabetical; picker is a §14 follow-up)
```

```ts
// lib/setup/staging.ts — ~/.mattstack/rt/setup-staging/<domain>.json (0600), consumed by the secrets.write step
export function stagingDir(home: string): string
export function stageSecret(p: Probes, domain: string, key: string, value: string): void      // merge into the domain file, 0600
export function listStaged(p: Probes): { domain: string; key: string }[]                      // names only
export function drainStaged(p: Probes, write: (domain: string, key: string, value: string) => Promise<void>): Promise<number>  // writes each, removes the file after ALL keys of that domain succeeded; returns count
```

```ts
// lib/setup/state.ts — ~/.mattstack/rt/setup-state.json
export interface SetupState { v: 1; marketplaces: string[]; plugins: string[]; links: string[]; extensionEditors: string[]; lastApplyAt?: string }
export function readSetupState(p: Pick<Probes, "readFile" | "home">): SetupState                  // defaults to empty arrays
export function updateSetupState(p: Pick<Probes, "readFile" | "writeFile" | "mkdirp" | "home">, patch: (s: SetupState) => SetupState): SetupState
```

- [ ] **Step 1: Failing tests** using `fakeProbes`: write→read round-trip of each shape; `writeIntent` records mode 0o600 (`calls.writes` plus a `modes` record — add `modes: Record<string, number>` to the fake's calls); `readIntent` on garbage → null; `teamRefFromIntent` table (5 cases above); `stageSecret` twice in one domain merges keys; `drainStaged` with a `write` that throws on the second key leaves the domain file in place and rethrows; `updateSetupState` dedupes arrays (`[...new Set]`).
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0.
- [ ] **Step 5: Commit** `MAT-383: setup intent, staged secrets, setup state`

---

### Task 4: Pack requirements reader + integrations table

**Files:**
- Create: `lib/setup/requirements.ts`, `lib/setup/integrations.ts`
- Test: `lib/setup/__tests__/requirements.test.ts`, `lib/setup/__tests__/integrations.test.ts`

**Interfaces:**
- Produces:

```ts
// lib/setup/requirements.ts — pack-side requirements.jsonc: teams/<slug>/**/requirements.jsonc (depth ≤ 4, e.g. mattstack/packs/<pack>/requirements.jsonc)
export interface ToolRequirement { name: string; floor?: string; why: string; install?: { brew?: string; url?: string }; connect?: { integration: Integration } | { verb: string[]; label: string }; optional?: boolean }
export interface PackRequirements { pack: string; tools: ToolRequirement[]; integrations: Integration[]; chrome?: { required: boolean; signedIntoApp?: string } ; workType?: string }
export function readPackRequirements(p: Pick<Probes, "readDir" | "readFile" | "exists" | "home">, teamSlug: string): PackRequirements[]   // [] when none; a malformed file yields one entry {pack, tools:[], integrations:[], error} — add `error?: string`
export function parseRequirements(packName: string, text: string): PackRequirements   // stripJsonc (lib/jsonc.ts) + shape validation; unknown integration names dropped with error text
```

```ts
// lib/setup/integrations.ts
export interface IntegrationDef {
  id: Integration; title: string; why: (teamHost: string | null) => string;
  fields: ConnectField[]; alternatives?: { id: "use-gh"; label: string }[];
  secret: { domain: "rt" | "board"; key: string };       // where connect stores the credential (user-scope secrets)
  /** Calls the API with the token; ready only when the token can see the team's resources. Network via probes.fetch/exec only. */
  validate(p: Probes, token: string, ctx: { host: string | null; team: { slug: string; remote: string | null } }): Promise<{ status: "ready" | "invalid"; detail: string; scopesSeen: string[] }>;
}
export const INTEGRATIONS: Record<Integration, IntegrationDef>
export function integrationDef(id: string): IntegrationDef   // throws UserActionableError("unknown-integration") on a bad id
```

Table (pin in code; all network through `p.fetch` or `p.exec`):

| id | fields | secret | validate |
|---|---|---|---|
| github | token (secret; hint "repo, read:org") ; alternatives `use-gh` | rt.githubToken | `GET https://api.github.com/user` with `Authorization: Bearer`; scopes from the `x-oauth-scopes` response header; if `ctx.team.remote` is a GitHub URL, `GET /repos/<owner>/<repo>` must be 200 → ready, 404 → invalid "token can't see <owner>/<repo>" |
| gitlab | token (secret; hint "read_api, read_user") | rt.gitlabToken | `GET https://<host>/api/v4/user` with `PRIVATE-TOKEN`; then `GET /api/v4/personal_access_tokens/self` → scopes; team project from remote → `GET /api/v4/projects/<urlencoded path>` 200 → ready |
| linear | apiKey (secret; hint "lin_api_…") | rt.linearApiKey | GraphQL `{ viewer { id } teams { nodes { key } } }`; ready when `mattstack.integrations.linear.teamKey` (passed in ctx as `linearTeamKey`) is among teams (or no teamKey declared → ready "viewer ok") |
| slack | (oauth; no fields) | board.slackToken | `POST https://slack.com/api/auth.test` with Bearer → `ok:true` → ready (team name in detail) |
| switchboard | token (secret) | rt.switchboardToken | `GET <url>/health` with Bearer → 200 |
| sdm | email (not secret) | rt.sdmEmail | `p.exec(["sdm","status"])` code 0 and stdout contains the email → ready; 127 → invalid "sdm not installed" |
| doppler | (no fields; connect = run `doppler login`) | — | `p.exec(["doppler","me","--json"])` code 0 → ready |
| ldcli | (no fields; connect = run `ldcli login`) | — | `p.exec(["ldcli","config","--list"])` code 0 → ready |

- [ ] **Step 1: Failing tests.** `parseRequirements("acme", '{ "tools":[{"name":"doppler","floor":"3.0.0","why":"secrets","install":{"brew":"dopplerhq/cli/doppler"},"connect":{"integration":"doppler"}}], "integrations":["gitlab","linear","bogus"] }')` → one tool, integrations `["gitlab","linear"]`, `error` mentions `bogus`; `readPackRequirements` with fake dirs `teams/acme/mattstack/packs/acme/requirements.jsonc` finds it, and with none returns `[]`. `integrations.test.ts`: gitlab `validate` with a fake fetch returning 200 for `/user`, `{scopes:["read_api"]}` for `/personal_access_tokens/self`, 404 for the project → `{status:"invalid", detail: contains "can't see", scopesSeen:["read_api"]}`; github 200/200 → ready; linear teamKey mismatch → invalid; every def has non-empty `why(null)`.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0.
- [ ] **Step 5: Commit** `MAT-383: pack requirements reader + integrations table`

---

### Task 5: deps — bundled tool resolution + tagged links + `rt deps`

**AFTER L4 T1 + L4 T9 merge** (rebase onto `origin/main` first): this task consumes `lib/bundle-layout.ts` (`appBundleRoot`, `bundleRootFromExec`, `bundledHelperPath`, `bundledExec`, `RT_BUNDLE_PATH`) and `installRtBinary` (`lib/dev-mode.ts`) / `installedTrayAppPath` (`lib/rt-paths.ts`) — L4 owns those files; L1 never edits them.

**Files:**
- Create: `lib/deps/resolve.ts`, `lib/deps/links.ts`, `commands/deps.ts`
- Test: `lib/deps/__tests__/resolve.test.ts`, `lib/deps/__tests__/links.test.ts`, `commands/__tests__/deps.test.ts`
- Modify: `lib/command-tree-def.ts` (new `deps` node), `lib/module-registry.ts` (`./commands/deps.ts`), `lib/daemon.ts` (boot: `await reconcileLinks(createRealProbes())` inside a try/catch that logs at warn — one call next to the existing boot reconcile; and, per the plist-PATH ruling, prepend `<appBundleRoot()>/Contents/Helpers` and `$HOME/.local/bin` to `process.env.PATH` at daemon boot — the agent plist's `EnvironmentVariables.PATH` is the static `/usr/bin:/bin:/usr/sbin:/sbin`, so rt derives the bundle dir from its own execPath; children spawned with `env: process.env` inherit it)

**Interfaces:**
- Consumes (L4 T1 `lib/bundle-layout.ts`): `appBundleRoot(exists?)`, `bundleRootFromExec(execPath?)`, `bundledHelperPath(name, root?, exists?)`, `bundledExec(name, root?, exists?)` (argv prefix from deps.lock — e.g. fast-browser = `[<root>/Contents/Helpers/node/bin/node, <root>/Contents/Helpers/fast-browser/bin/fast-browser.mjs]`), `RT_BUNDLE_PATH` (`Contents/MacOS/rt`); (L4 T9) `installRtBinary(src)` (atomic link-then-rename of `~/.local/bin/rt`).
- Produces:

```ts
// lib/deps/resolve.ts  — no HELPER_TOOLS list: which helpers exist comes from the bundle's deps.lock via bundle-layout
export function appBundlePath(p: Pick<Probes, "exists" | "home">): string | null      // = appBundleRoot(p.exists) (bundle rt runs from, else installed active flavor — which already reads mattstack.appPath)
export function bundledToolPath(p: Pick<Probes, "exists" | "home">, tool: string): string | null   // tool === "rt" ? join(root, RT_BUNDLE_PATH) : bundledHelperPath(tool, root, p.exists); null when no app or absent
export function bundledToolExec(p: Pick<Probes, "exists" | "home">, tool: string): string[] | null // tool === "rt" ? [join(root, RT_BUNDLE_PATH)] : bundledExec(tool, root, p.exists)
export function userCopyOnPath(p: Pick<Probes, "exists" | "readlink" | "env" | "home">, tool: string): string | null  // first PATH entry holding an executable `tool` that is NOT our tagged link
export interface ToolResolution { tool: string; bundled: string | null /* first exec entry / path, for display */; exec: string[] | null /* bundled exec argv prefix, else [userCopy], else null */; userCopy: string | null; linked: boolean; chosen: string | null /* bundled ?? userCopy */ }
export function resolveTool(p: Probes, tool: string): ToolResolution
```

```ts
// lib/deps/links.ts
export const DEFAULT_EXPOSED = ["rt","fast-browser","gitq","deck"] as const;
export const LINK_TAG = "# mattstack-link:";
export function linkPath(home: string, tool: string): string                         // ~/.local/bin/<tool>
/** A link is ours iff it is a symlink whose target lies inside the app bundle (Contents/Helpers or Contents/MacOS), OR a regular file whose second line starts with `# mattstack-link:` (the tagged wrapper for multi-argv tools). */
export function isOurLink(p: Pick<Probes, "readlink" | "readFile" | "exists" | "home">, tool: string): boolean
export type LinkOutcome = { ok: true; path: string; state: "linked" | "already" } | { ok: false; reason: "no-bundle" | "user-copy" | "dev-mode-owns-rt" | "occupied"; detail: string }
export function link(p: Probes, tool: string, opts?: { force?: boolean }): LinkOutcome
//  exec = bundledToolExec(p, tool) (null → no-bundle); exec.length === 1 → symlink (for "rt": installRtBinary(target) — atomic link-then-rename — never a bare p.symlink); exec.length > 1 → write the tagged wrapper
//  `#!/bin/sh\n# mattstack-link: <tool>\nexec "<exec0>" "<exec1…>" "$@"\n` (mode 0755); refuses "user-copy" unless force; rt in dev mode → dev-mode-owns-rt; a non-ours regular file at the path → occupied
export function unlink(p: Probes, tool: string): { removed: boolean }                       // only removes our links (symlink or tagged wrapper)
export function reconcile(p: Probes): { removed: string[]; kept: string[] }                 // every our-link (either form) whose tool now has a user copy elsewhere on PATH is removed (auto-unlink)
```

`commands/deps.ts`: `depsResolve(args)` → `rt deps resolve <tool> --json` prints `envelope(resolveTool(...))`; `depsLink(args)` → `rt deps link <tool> [--force] [--json]`; `depsUnlink(args)`; `depsReconcile(args)` → `rt deps reconcile [--json]`. Tree: `deps: { description: "Bundled tools: resolve by absolute path, expose on PATH with tagged links", subcommands: { resolve, link, unlink, reconcile } }` each with `module: "./commands/deps.ts"`, fn names as above, `args` with Tool text + `--json` boolean (+ `--force` on link).

- [ ] **Step 1: Failing tests.** `resolve.test.ts`: with HOME store seeded `mattstack.appPath` → `/Applications/mattstack.app` (use `setSetting("mattstack.appPath","/Applications/mattstack.app","machine")` against the test HOME), a fake `Contents/Resources/deps.lock` listing `gh` (`bundlePath: Contents/Helpers/gh`, `exec: [Contents/Helpers/gh]`, `status: bundled`) and `fast-browser` (`exec: [Contents/Helpers/node/bin/node, Contents/Helpers/fast-browser/bin/fast-browser.mjs]`), and fake `exists` true for those paths → `bundledToolPath(p,"gh")` equals `/Applications/mattstack.app/Contents/Helpers/gh`; `"rt"` → `.../Contents/MacOS/rt`; `bundledToolExec(p,"fast-browser")` is the two-entry argv; `resolveTool(p,"fast-browser").exec` equals it and `.bundled` is its first entry; `userCopyOnPath` with `env.PATH="/opt/homebrew/bin:/Users/x/.local/bin"`, `exists("/opt/homebrew/bin/gh")` → returns that; when the only hit is `~/.local/bin/gh` and `readlink` says it points into the bundle → null. `links.test.ts`: `link("gh")` creates a symlink target=bundled path (assert `calls.symlinks`); `link("rt")` goes through `installRtBinary` (assert the atomic `<dest>.new` → rename, via an injectable seam), never a bare symlink; `link("fast-browser")` writes the tagged wrapper file (second line `# mattstack-link: fast-browser`, exec line quoting both argv entries, mode 0755) and `isOurLink(p,"fast-browser")` is true for it; second call → `already`; `link("gh")` when a user copy exists → `{ok:false, reason:"user-copy"}`; with `{force:true}` → links; `link("rt")` when `~/.local/bin/rt` starts with `#!` and has no `# mattstack-link:` second line → `dev-mode-owns-rt` (fake `readFile`); `unlink` removes both forms; `reconcile` removes the gh link once `/opt/homebrew/bin/gh` appears, keeps `rt`. `deps.test.ts`: `depsResolve(["gh","--json"])` prints an envelope with `contract:1` and an `exec` array.
- [ ] **Step 2:** fail. **Step 3:** implement; tree + registry in the same change. **Step 4:** green (incl. `lib/__tests__/module-registry.test.ts`); tsc 0.
- [ ] **Step 5: Commit** `MAT-383: rt deps — bundled resolution, tagged links, reconcile`

---

### Task 6: Validators — mac group + permissions merge

**Files:**
- Create: `lib/setup/permissions.ts`, `lib/setup/validators/mac.ts`
- Test: `lib/setup/__tests__/permissions.test.ts`, `lib/setup/__tests__/validators-mac.test.ts`

**Interfaces:**
- Produces:

```ts
// lib/setup/permissions.ts
export interface PermissionsReply { fda: { status: "granted"|"denied"|"unknown"; detail?: string }; notifications: { status: "authorized"|"denied"|"notDetermined"|"provisional" }; loginItems: { status: "enabled"|"requiresApproval"|"notRegistered"|"notFound" } }
export async function fetchPermissions(tray: TrayClient): Promise<PermissionsReply | null>   // GET /permissions; null when status !== 200
export function permissionRows(reply: PermissionsReply | null, daemonTcc: { blocked: number; total: number } | null): Row[]
```
Row mapping (ids `perm.fda`, `perm.login-items`, `perm.notifications`; `kind:"permission"`, `recheck:"on-activate"`):
- fda: granted → ready "Granted"; denied → needs-you "Not granted", action `{type:"open-settings", label:"Open Full Disk Access Settings…", target:"fda"}`; unknown → needs-you "Could not verify", same action. reply null: daemonTcc `{blocked:0,total>0}` → ready "Daemon reads all N repos (checked via the daemon)"; `{blocked>0}` → needs-you with the same action; else → error "mattstack.app not running — permission status unavailable" with action `{type:"run", label:"Re-check", verb:["setup","status"]}`. required:true. why: "Reads your repositories' git state so the daemon can show branch and MR status."
- login-items: enabled → ready; requiresApproval → needs-you "Approve in Login Items", action `{type:"open-settings", label:"Open Login Items…", target:"login-items"}`; notRegistered/notFound → missing "Not registered yet (Install registers it)", action null; reply null → error as above. required:true.
- notifications: authorized/provisional → ready; notDetermined → needs-you "Not requested", action `{type:"request-permission", label:"Allow", which:"notifications"}`; denied → needs-you, action `{type:"open-settings", label:"Open Notification Settings…", target:"notifications"}`; null → skipped "not checked (app not running)". required:false, optionalNote "Works without this; you'll see menu-bar badges instead."

```ts
// lib/setup/validators/mac.ts
export async function macRows(p: Probes): Promise<Row[]>   // tool.macos, tool.clt, tool.path  (perm rows come from permissions.ts; plan.ts concatenates)
```
- `tool.macos`: `p.exec(["sw_vers","-productVersion"])`; major ≥ 14 → ready "macOS <v>"; else invalid "macOS 14 or newer required"; required:true; action null.
- `tool.clt`: `p.exec(["xcode-select","-p"])` code 0 AND `p.exec(["git","--version"])` code 0 → ready "git <v>"; else missing "Apple command line tools not installed", action `{type:"install", label:"Install…", tool:"apple-clt", via:"apple-clt"}`; required:true.
- `tool.path`: kind "info", required:false (informational, Install fixes it): PATH order check — first entry of `p.env.PATH` that exists is `~/.local/bin` AND `~/.zshenv` contains the precedence block marker `# mattstack — PATH precedence` → ready; shell rc has the block but not first → needs-you "~/.local/bin is on PATH but not first — team intercept shims may not fire"; absent → missing "Install adds ~/.local/bin to PATH"; detail names the rc file. No action (fixed by path.link).

- [ ] **Step 1: Failing tests.** `permissionRows` table-driven for all 11 mappings above (assert id/status/action.type/target/required). `macRows` with fake exec: sw_vers "15.6" → ready; "13.7" → invalid; xcode-select 127 → missing with install action via apple-clt; PATH starting with `/opt/homebrew/bin` and a rc block present → needs-you.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0. **Step 5: Commit** `MAT-383: mac validators + permission rows from tray.sock`

---

### Task 7: Validators — rt health (the existing `rt verify` checks as rows)

**AFTER L1 T5 and L4 T11 merge** (`resolveFzf()` in `lib/fzf.ts` is L4's; rebase onto `origin/main` first). L4's competing `commands/verify.ts` edit ("rt link" + "bundled extension" checks) is dropped — the two rows below carry it.

**Files:**
- Create: `lib/setup/validators/rt-health.ts`
- Test: `lib/setup/__tests__/validators-rt-health.test.ts`

**Interfaces:**
- Consumes: `resolveFzf()` (`lib/fzf.ts`, L4 T11 — bundled path first, then PATH); `appBundlePath` (Task 5), `RT_BUNDLE_PATH` (`lib/bundle-layout.ts`).
- Produces: `export async function rtHealthRows(p: Probes, opts: { ci: boolean }): Promise<Row[]>` with rows in this order and these ids (all `kind:"tool"`, group `tools`):

| id | required | ready when | otherwise |
|---|---|---|---|
| tool.rt | true | `p.exec(["rt","--version"])` code 0 (detail = stdout) | missing "rt not found on PATH" (action `{type:"link-bundled", label:"Use mattstack's", tool:"rt"}`) |
| tool.rt-link | false | prod mode only (`currentMode()==="prod"`; dev → skipped "dev mode owns ~/.local/bin/rt"): `p.readlink(~/.local/bin/rt) === join(appBundlePath(p), "Contents/MacOS/rt")` → ready "linked into the bundle" | needs-you "not a link into mattstack.app — run: rt setup apply --from path.link"; no app → skipped |
| tool.legacy-dirs | true | `legacyDirsPresent()` real=[] (symlinks → ready with detail "compat symlink still present: …") | invalid "real legacy dir present: … — rt reads only ~/.mattstack/rt" |
| tool.intercepts | false | `shimReport()` all installed+current and `~/.local/bin` on PATH and `staleIntercepts().stale===false` (no rules → skipped "no intercepts declared") | needs-you with the same messages verify prints today, action `{type:"run", label:"Re-install shims", verb:["intercept","install"]}` |
| tool.fzf | true | `resolveFzf()` non-null → detail `fzf <version> (bundled|PATH)` (bundled when the resolved path is inside the bundle) | missing "fzf not found" action link-bundled fzf |
| tool.app | true | `appBundlePath(p)` non-null (detail path + CFBundleShortVersionString via `p.exec(["/usr/libexec/PlistBuddy","-c","Print CFBundleShortVersionString",<plist>])`) ; legacy `rt-tray.app` present → detail appends "legacy rt-tray.app still present" | missing "mattstack.app not found in /Applications or ~/Applications" |
| tool.vsix | false | `p.exists(<app>/Contents/Resources/rt-context.vsix)` → ready "bundled extension present" | missing → skipped "extension not bundled (pre-bundle build)"; no app → skipped |
| tool.extension | false | `checkRtContextExtension(home)` (moved from verify.ts to this module) pass | warn→needs-you with action `{type:"run", label:"Install extension", verb:["tools","setup","extension"]}`; no editors → skipped |
| tool.shell | false | rc file contains `rtcd` | needs-you "shell integration missing — Install writes it" |
| tool.daemon | true | `isDaemonInstalled()` and `p.daemon("ping")` ok; detail from `status` (pid/uptime/watched) | not installed → missing "run Install (registers the daemon)"; installed but down → ci ? needs-you "not booted (expected in CI)" : needs-you "installed but not responding — approve in Login Items", action open-settings login-items |

Both `tool.daemon` sub-facts (launchd label via `p.exec(["launchctl","list",activeLaunchdLabel()])`, `worktrees` endpoint) fold into `detail`, not separate rows. `tcc:check` is consumed by Task 6's `perm.fda` fallback (plan.ts passes it in), not here.

- [ ] **Step 1: Failing tests** (fake probes; HOME is the test temp dir): rt --version ok → `tool.rt` ready with detail; `tool.rt-link` ready when `readlink` returns the bundle's `Contents/MacOS/rt`, needs-you when it points elsewhere, skipped in dev mode; `tool.vsix` ready/skipped by `exists`; `tool.fzf` detail says "bundled" when `resolveFzf` (injected) returns a path under the bundle; `legacyDirsPresent` via a real `.rt` dir created under the test HOME → invalid; daemon not installed (no daemon.json in test HOME) → `tool.daemon` missing; `ci:true` + installed + ping null → needs-you containing "CI"; app missing → missing. Also an order test: ids equal the table order.
- [ ] **Step 2:** fail. **Step 3:** implement (move `checkRtContextExtension` here; re-export it from `commands/verify.ts` so `commands/__tests__/verify.test.ts` keeps passing unchanged). **Step 4:** green; tsc 0. **Step 5: Commit** `MAT-383: rt health validators (verify checks become rows)`

---

### Task 8: Validators — tools group (provisioned, bundled, team-declared, packs)

**AFTER L1 T5 and L4 T11 merge** (uses `resolveTool(...).exec` from Task 5; rebase onto `origin/main` first). `commands/post-install.ts` is L1-owned (L4 T9 dropped its edit of that file); the `detectEditors` import change here is the only Task-8 touch of it.

**Files:**
- Create: `lib/setup/validators/tools.ts`, `lib/setup/semver.ts`, `lib/editors.ts`
- Modify: `commands/extension.ts`, `commands/post-install.ts` (import `detectEditors`/`EDITOR_PATTERNS` from `lib/editors.ts`)
- Test: `lib/setup/__tests__/validators-tools.test.ts`, `lib/setup/__tests__/semver.test.ts`

**Interfaces:**
- Produces: `export function atLeast(version: string, floor: string): boolean` (numeric dotted compare, ignores leading "v" and suffixes); `export async function toolRows(p: Probes, reqs: PackRequirements[], opts: { hasBrew: boolean }): Promise<Row[]>`:

| id | required | probe | ready | otherwise |
|---|---|---|---|---|
| tool.herdr | true | `herdr --version` (floor `0.7.5`) + `herdr integration status` | version ≥ floor and integration stdout contains "claude" → detail "herdr <v>, Claude integration installed"; integration missing → needs-you action `{type:"run", label:"Install integration", verb:["tools","setup","herdr"]}` | 127 → missing, action `{type:"install", label:"Install", tool:"herdr", via: hasBrew ? "brew" : "vendor"}`; below floor → invalid "herdr <v> < 0.7.5" |
| tool.claude | true | `claude --version`; sign-in: `claude auth status` code 0 → signed in; unknown subcommand (stderr contains "unknown") → detail "installed (sign-in not checked)" ready | ready | 127 → missing, action install via brew/vendor; auth status code ≠0 (and known) → needs-you "sign in: run claude once", action `{type:"steps", label:"Show steps…", steps:["Open a terminal","Run: claude","Follow the sign-in prompt"]}` |
| tool.fast-browser | true | `p.exec([...resolveTool(p,"fast-browser").exec, "doctor", "--json"])` (the bundled exec is `[node, fast-browser.mjs]`, never `chosen` as argv0) → parse `{runtime:{ok}, extension:{loaded}, pairing:{ok}}` (tolerate missing keys) | runtime ok AND extension loaded | extension not loaded → needs-you action `{type:"steps", label:"Show steps…", steps:["Open chrome://extensions","Turn on Developer mode","Load unpacked → ~/.fast-browser/extension/current/unpacked"]}`; `exec` null → missing (bundled-link action); doctor parse failure → error with stderr head |
| tool.editor | false | `detectEditors()` — moved with `EDITOR_PATTERNS` into a new `lib/editors.ts` (this task; `commands/extension.ts` and `commands/post-install.ts` import it from there, behavior unchanged) | ≥1 editor → detail names | skipped "no editor found (works without this)" |
| tool.chrome | required iff any `reqs[].chrome?.required` | `p.exists("/Applications/Google Chrome.app")` or `~/Applications/...` | ready | missing, action `{type:"open-url", label:"Download", url:"https://www.google.com/chrome/"}`; optional otherwise; a pack `signedIntoApp` adds a needs-you row `tool.chrome-signin` with steps |
| tool.mission-control | false | `defaults read com.apple.symbolichotkeys AppleSymbolicHotKeys` → key "32" → `enabled` 0 | unbound → ready | bound → needs-you "Control+Up is bound to Mission Control (rt nav uses it)", action `{type:"open-settings", label:"Open Keyboard Settings…", target:"keyboard"}`; exec fails → skipped |
| tool.<name> (per `reqs[].tools`) | !optional | `<name> --version` | present (and ≥ floor when given) → detail version; `connect` present and row "connect" unresolved → stays ready (connect is an account row) | missing → action install via brew when `install.brew` and hasBrew, else `open-url install.url` when given, else `steps`; why = requirement.why |
| pack.<pack> | true | `claude plugin list` stdout contains `<pack>@` | ready "installed" | missing "installed by Install (plugins.install)"; claude missing → skipped |

- [ ] **Step 1: Failing tests.** semver: `atLeast("0.8.0","0.7.5")` true, `atLeast("v0.7.4","0.7.5")` false, `atLeast("24.19.0","24")` true. tools: fake exec script keyed on argv[0]; herdr 127 + hasBrew → install via brew; herdr "0.8.0" + integration "claude: installed" → ready; fast-browser with `exec=[node, mjs]` → recorded argv is `[node, mjs, "doctor", "--json"]` and doctor `{"runtime":{"ok":true},"extension":{"loaded":false}}` → needs-you with 3 steps; team tool `doppler` missing with brew formula → install action `tool:"doppler", via:"brew"`; pack row from `reqs=[{pack:"acme",...}]` with plugin list containing `acme@acme` → ready.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0. **Step 5: Commit** `MAT-383: tools validators (provisioned, bundled, team-declared, packs)`

---

### Task 9: Validators — accounts + access

**Files:**
- Create: `lib/setup/validators/accounts.ts`, `lib/setup/validators/access.ts`, `lib/setup/team-settings.ts`
- Test: `lib/setup/__tests__/validators-accounts.test.ts`, `lib/setup/__tests__/validators-access.test.ts`

**Interfaces:**
- Produces:

```ts
// lib/setup/team-settings.ts — the only place plan/apply read team keys (through getSetting)
export interface TeamIntegrations { forge?: { host: string; provider: "github" | "gitlab" }; slack?: { appId?: string; clientId?: string; channel?: string; callbackPort?: number }; linear?: { teamKey: string }; switchboard?: { url: string } }
export interface TeamSnapshot { slug: string; integrations: TeamIntegrations; trackingIdentities: string[]; marketplaces: string[]; plugins: string[]; remote: string | null }
export function readTeamSnapshot(p: Probes, slug: string): TeamSnapshot   // getSetting("mattstack.integrations"), getSetting("mattstack.tracking") → Object.keys(repos), claude.marketplaces/plugins; remote via p.readFile(teams/<slug>/.git/config) + parseOriginUrl
export function forgeFromRemote(remote: string): { host: string; provider: "github" | "gitlab" } | null   // github.com → github; anything else → gitlab (self-hosted assumption), null when unparsable
```

```ts
// lib/setup/validators/accounts.ts
export interface SecretPresence { has(domain: string, key: string): Promise<string | null> }   // reads user-scope secrets (lib/secrets/store.readSecret) — null when no key yet (NoAgeKeyError → treated as absent) — plus staged values (staging.ts)
export async function accountRows(p: Probes, team: TeamSnapshot, reqs: PackRequirements[], secrets: SecretPresence, intent: SetupIntent | null): Promise<Row[]>
```
Rows: one `account.<integration>` per declared integration — declared = `team.integrations.forge.provider` (always) ∪ `linear` if `team.integrations.linear` ∪ `slack` if `team.integrations.slack?.clientId` ∪ `switchboard` if `team.integrations.switchboard` ∪ every `reqs[].integrations` ∪ `reqs[].tools[].connect.integration`. Status: secret absent (and no gh auth for github) → missing with `connect` action from `INTEGRATIONS[id]` (github adds `alternatives:[{id:"use-gh",label:"Use gh login"}]` when `p.exec(["gh","auth","status"])` code 0, and when gh IS authenticated and no token stored → ready "via gh (<user>)"); present → call `def.validate` → ready/invalid (detail from validator; `recheck:"on-change"`). Slack action is `{type:"oauth", label:"Connect", integration:"slack", verb:["setup","slack","connect"]}`. Owner-once `account.slack-app` (before `account.slack`) appears when `slack` is wanted by a pack (`reqs[].integrations` includes slack) but `team.integrations.slack?.clientId` is absent AND `intent?.mode === "create"` (or no intent and the user is the team owner: `board.members[0]?.username` equals the forge login — keep simple: mode create or none with a single team); action `{type:"owner-once", label:"Create the team's Slack app…", integration:"slack", fields:[{name:"configToken", label:"App configuration token", secret:true}]}`; status missing; required true. `account.switchboard` detail "redeemed during Join" when intent.mode==="join" and secret present → ready.

```ts
// lib/setup/validators/access.ts
export async function accessRows(p: Probes, team: TeamSnapshot, intent: SetupIntent | null): Promise<Row[]>
```
- `access.team-repo` (required): remote = `intent?.team?.remote ?? intent?.join?.pointer.remote ?? team.remote`; `p.exec(["git","ls-remote","--exit-code",remote,"HEAD"],{timeoutMs:15000, env:{GIT_TERMINAL_PROMPT:"0"}})` code 0 → ready "reachable"; code 2 → ready "empty repo (will be initialized)"; 128 + stderr matches /Authentication|403|Permission denied|could not read Username/ → needs-you "you don't have access yet: ask the owner to grant you access" (never prints the URL); other → error "unreachable: <first stderr line>"; no remote → missing "no team remote yet (screen 2)".
- `access.forge` (required): `p.fetch("https://<host>/", {method:"HEAD", timeoutMs:5000})` status > 0 → ready.
- `access.repo.<slug>` per `team.trackingIdentities` (required:false, optionalNote "Works without this; the board won't show this repo"): `git ls-remote --exit-code https://<identity>.git HEAD` → ready / needs-you (auth) / error.
- `access.switchboard` (required:false) when `team.integrations.switchboard` → `GET <url>/health` 200.

- [ ] **Step 1: Failing tests.** accounts: team forge gitlab + no secret → `account.gitlab` missing with `connect` action fields `[{name:"token",...}]`; secret present + validator 200s → ready; github with gh authenticated and no token → ready "via gh"; reqs wanting slack + create intent + no clientId → `account.slack-app` owner-once row precedes `account.slack`; linear declared → row present, not declared → absent. access: ls-remote 0 → ready; stderr "Authentication failed" → needs-you and detail does not contain the remote URL; tracking identities produce `access.repo.<slug>` rows with slug = identity with `/`→`-`.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0. **Step 5: Commit** `MAT-383: accounts + access validators`

---

### Task 10: Plan composition + `rt setup plan|status` + `setup` node

**AFTER L1 T5 and L4 T11 merge** (composes Tasks 7–9). `cli.ts` is L1-owned (L4 T10's comment-only edit is dropped).

**Files:**
- Create: `lib/setup/plan.ts`, `commands/setup.ts`
- Test: `lib/setup/__tests__/plan.test.ts`, `commands/__tests__/setup-plan.test.ts`
- Modify: `lib/command-tree-def.ts` (new `setup` node), `lib/module-registry.ts` (`./commands/setup.ts`), `cli.ts` (first-run hook, see Step 3)

**Interfaces:**
- Produces:

```ts
// lib/setup/plan.ts
export interface PlanInputs { p: Probes; secrets: SecretPresence; ci: boolean; teamOverride?: string }
export async function composePlan(i: PlanInputs): Promise<Plan>
//  1. intent = readIntent(p); teams = listTeams(); team = teamRefFromIntent(intent, teams) (teamOverride wins when it names a cloned team)
//  2. snapshot = team.slug ? readTeamSnapshot(p, team.slug) : empty; reqs = readPackRequirements(p, team.slug)
//  3. rows: mac = [...permissionRows(await fetchPermissions(p.tray), tcc), ...await macRows(p)]  (tcc = p.daemon("tcc:check") → {blocked, total})
//     accounts = await accountRows(...); access = await accessRows(...); tools = [...await toolRows(p, reqs, {hasBrew}), ...await rtHealthRows(p,{ci})]
//  4. finalizePlan(team, [mac, accounts, access, tools] as Groups with GROUP_TITLES, p.now())
export function realSecretPresence(): SecretPresence   // readSecret over real seams; NoAgeKeyError → null; also consults staging
```

```ts
// commands/setup.ts (this task: plan/status only; later tasks add the rest)
export async function setupPlan(args: string[], _ctx?: CommandContext, deps = realSetupDeps()): Promise<void>     // --json | human table; --team <name>
export async function setupStatus(args: string[], _ctx?: CommandContext, deps = realSetupDeps()): Promise<void>   // same plan; human header "rt setup status"
export interface SetupDeps { probes: Probes; secrets: SecretPresence; print: (s: string) => void }
export function realSetupDeps(): SetupDeps
export function renderPlanHuman(plan: Plan): string[]   // group headers + "  <glyph> <title>  <detail>" + footer "Install: ready|blocked by: …"; glyphs ✓ ready · ✗ missing/invalid/error · ! needs-you · – skipped · … checking
```
Tree node (exact):
```ts
setup: {
  description: "Set this Mac up for mattstack: readiness plan, install steps, account connections",
  module: "./commands/setup.ts", fn: "setupInteractive",            // this task: setupInteractive === setupStatus; Task 27 gives it the interactive walk
  args: [{ name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Machine-readable plan" }],
  subcommands: {
    plan:   { description: "Compute the readiness checklist", module: "./commands/setup.ts", fn: "setupPlan",   args: [{ name: "Team", flag: "--team", type: "text", placeholder: "acme", hint: "Which cloned team to plan for" }, { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Machine-readable plan" }] },
    status: { description: "The same checklist as a post-install health view", module: "./commands/setup.ts", fn: "setupStatus", args: [{ name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Machine-readable plan" }] },
    // apply + intent (Task 27), pack (Task 28), <integration> + slack create-app (Task 12) are added by their tasks
  },
},
```

- [ ] **Step 1: Failing tests.** `plan.test.ts`: with fake probes (tray `GET /permissions` → all granted; exec script answering every probe the validators make with "ready" shapes; no intent; no teams) → plan has 4 groups in order `mac, accounts, access, tools`, `team.mode==="none"`, `perm.fda` ready; with tray status 0 and daemon tcc `{blocked:0,total:2}` → `perm.fda` ready with "via the daemon" detail; with an intent `{mode:"create", team:{slug:"acme",...remote:"https://github.com/o/r.git"}}` → `team` is `{slug:"acme", name:"Acme", mode:"create"}` and `account.github` exists. `setup-plan.test.ts`: `setupPlan(["--json"], {}, deps)` prints exactly one line that parses to a Plan with `contract:1`; human mode prints "Your Mac".
- [ ] **Step 2:** fail. **Step 3:** implement; `setupInteractive` this task = `setupStatus` (replaced in Task 28). **cli.ts first-run hook**: the `daemon.json`-absent branch no longer auto-runs post-install; it prints `  rt is not set up yet — open mattstack.app, or run: rt setup` (once, to stderr) and continues, and it is skipped entirely when `args[0]` ∈ `setup, team, deps, services, tools, repos, skills, cron, uninstall, home, secrets, restore, verify` or `RT_APP_SOCKET` is set. `args[0] === "--post-install"` never reaches the hint: the earlier `--post-install` branch in `cli.ts` dispatches before the first-run hook runs (no change needed; stated so nobody adds it to the skip list twice). Keep `RT_SKIP_SETUP`/`CI` respected. `verify` keeps its direct-dispatch branch.
- [ ] **Step 4:** green (module-registry test included); tsc 0.
- [ ] **Step 5: Commit** `MAT-383: rt setup plan|status — plan composition over the validators`

---

### Task 11: `rt verify` runs the validators

**AFTER L1 T5 and L4 T11 merge.** `commands/verify.ts` is L1-owned: L4 T11's edit of it (fzf block, "rt link", "bundled extension" checks) is dropped; Task 7's `tool.fzf`/`tool.rt-link`/`tool.vsix` rows carry that content, so no rebase conflict arises here.

**Files:**
- Modify: `commands/verify.ts` (replace `runChecks` with a mapping over `composePlan`), keep `printHuman`/`printJSON` shapes
- Test: `commands/__tests__/verify-mapping.test.ts`; existing `commands/__tests__/verify.test.ts` untouched

**Interfaces:**
- Produces: `export function rowsToChecks(plan: Plan, opts: { ci: boolean }): CheckResult[]` (exported for tests) with mapping: ready → pass; skipped/checking → skip; missing/invalid/error/needs-you → required ? fail(critical) : warn; exceptions: `perm.*` rows in `ci` mode are never critical (downgrade to warn); `tool.daemon` needs-you in ci → warn (existing behavior). `name` = row.id, `detail` = row.detail (+ ` — ${action.label}` hint when an action exists). `runVerify(args)`: `--json` prints `{passed, summary, checks, plan}` (adds the raw plan — additive); exit 1 when any critical fail.
- [ ] **Step 1: Failing tests** for `rowsToChecks`: required missing → fail critical; optional missing → warn; `perm.fda` needs-you with ci → warn; ready → pass; the JSON summary counts.
- [ ] **Step 2:** fail. **Step 3:** implement; delete the old `cmd()`/check bodies (they now live in validators). Keep `checkRtContextExtension` re-export. **Step 4:** green; tsc 0; `bun run cli.ts verify --json` from the worktree prints JSON (a smoke, not a test). **Step 5: Commit** `MAT-383: rt verify = the setup validators, one implementation`

---

### Task 12: `rt setup <integration> status|connect` + `rt setup slack create-app`

**Files:**
- Create: `lib/setup/slack-app.ts`
- Modify: `commands/setup.ts` (add `integrationVerb` factory + 16 exports + `setupSlackCreateApp`), `lib/command-tree-def.ts` (integration nodes under `setup`)
- Test: `commands/__tests__/setup-connect.test.ts`, `lib/setup/__tests__/slack-app.test.ts`

**Interfaces:**
- Produces:

```ts
// commands/setup.ts
export async function integrationStatus(id: Integration, args: string[], deps: SetupDeps): Promise<void>   // prints envelope({integration, status, detail, scopesSeen}) from accountRows-equivalent single-row evaluation
//  github only: when gh is authenticated (`gh auth status` code 0) the envelope also carries `handle` (`gh api user` → .login) and `owners: [handle, ...(gh api user/orgs → [].login)]` — the app's Create-team card reads them (contract: `rt setup github status --json`)
export async function integrationConnect(id: Integration, args: string[], deps: SetupDeps & { stdin: () => Promise<unknown> }): Promise<void>
//  stdin JSON {"token": "..."} | {"useGh": true} | {"email": "..."} (field names = def.fields[].name); --token-stdin reads a raw token line; TTY without stdin → promptSecretValue per secret field
//  1. validate via def.validate → invalid → print envelope + exit 2 (code "invalid-credential")
//  2. store: age key present → writeSecret(domain,key,value) ; absent → stageSecret (detail "staged until Install creates your key")
//  3. print envelope({ integration, status:"ready", detail, scopesSeen })
//  useGh: token = p.exec(["gh","auth","token"]) stdout; stored like a token; detail "via gh"
//  doppler/ldcli: connect = p.exec(["doppler","login"]) / (["ldcli","login"]) inheriting the TTY (probes.exec with opts.inherit:true — add to Probes) then re-validate
//  slack: connect = OAuth: build https://slack.com/oauth/v2/authorize?client_id=<team.integrations.slack.clientId>&user_scope=<scopes>&redirect_uri=http://localhost:<callbackPort>/callback ; open it (p.exec(["open", url])); listen on callbackPort (Bun.serve, injectable `deps.listen`) for one request; exchange code at https://slack.com/api/oauth.v2.access with clientId + client secret (team secret board.slackClientSecret via readTeamSecret — Task 13; absent → exit 2 "slack-app-missing"); store authed_user.access_token as board.slackToken (user scope)
export const setupGithubStatus = (a: string[], c?: CommandContext, d = realConnectDeps()) => integrationStatus("github", a, d);   // … ×8 ids × {Status, Connect}
export async function setupSlackCreateApp(args: string[], _ctx?: CommandContext, deps = realConnectDeps()): Promise<void>
//  --config-token-stdin ⇒ a raw token line on stdin; no flag ⇒ stdin JSON {"configToken"} (the app sends JSON without the flag); hardening: under the flag, a line that parses as a JSON object is read as {"configToken"} too. Builds manifest via buildSlackManifest(); POST https://slack.com/api/apps.manifest.create (Bearer config token) → {app_id, credentials:{client_id, client_secret, signing_secret}}
//  writes mattstack.integrations.slack {appId, clientId, callbackPort} via setSetting(..., "team", {team: slug}) (deep-merge preserves forge/linear); writes team secrets board.slackClientSecret + board.slackSigningSecret via writeTeamSecret (Task 13 — executed before this task, see the execution-order note at the end)
```

```ts
// lib/setup/slack-app.ts
export interface SlackScopeNeeds { bot: string[]; user: string[] }
export const DEFAULT_SCOPE_NEEDS: SlackScopeNeeds = { bot: ["chat:write","reactions:write","channels:read","users:read"], user: ["reactions:write","chat:write"] }
export function buildSlackManifest(opts: { name: string; callbackPort: number; scopes: SlackScopeNeeds }): object   // display_information, oauth_config.redirect_urls [http://localhost:<port>/callback], scopes, settings.org_deploy_enabled false
export const DEFAULT_CALLBACK_PORT = 11234
```
Tree: for each id in `github gitlab linear slack switchboard sdm doppler ldcli`: `setup.subcommands[id] = { description: "<Title>: check or connect this account", subcommands: { status: { module, fn: "setup<Id>Status", args:[json] }, connect: { module, fn: "setup<Id>Connect", args:[json, {name:"Token on stdin", flag:"--token-stdin", type:"boolean"}, {name:"Use gh", flag:"--use-gh", type:"boolean"}] } } }`; `slack` adds `"create-app": { fn:"setupSlackCreateApp", args:[{flag:"--config-token-stdin"...}, json] }`. Generate these nodes with a local helper in command-tree-def.ts (`integrationNode(id, title)`), keeping the module side-effect free.

- [ ] **Step 1: Failing tests.** `setup-connect.test.ts`: gitlab connect with stdin `{"token":"glpat-x"}` and a fake fetch making validate ready, no age key (fake `SecretPresence`/writer seam reports `hasKey:false`) → prints `{...,"status":"ready"}` and the staging file `rt/setup-staging/rt.json` contains `gitlabToken` (assert via fake `writes`); validate invalid → exit code 2 captured (stub `process.exit` via a `deps.exit` seam — add `exit: (code:number)=>never` to SetupDeps) and payload `error.code==="invalid-credential"`; `--use-gh` → exec `["gh","auth","token"]` called and token stored; `setupGithubStatus(["--json"])` with gh authenticated (fake `gh api user` → `{"login":"matt"}`, `gh api user/orgs` → `[{"login":"m4ttstack"}]`) → envelope has `handle:"matt"`, `owners:["matt","m4ttstack"]`; gh unauthenticated → no `handle`/`owners` keys. `slack-app.test.ts`: manifest has redirect url with the port and both scope lists; `setupSlackCreateApp` with fake fetch returning credentials → `setSetting` called (spy on a `writeSetting` seam in deps) with `mattstack.integrations` containing `{slack:{appId,clientId,callbackPort}}` and team secrets written for clientSecret+signingSecret (fake team-secret writer records).
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0; module-registry test green. **Step 5: Commit** `MAT-383: rt setup <integration> status|connect, slack create-app`

---

### Task 13: Team-scope secrets (N-recipient) + `rt secrets … --team`

**Files:**
- Create: `lib/secrets/team-store.ts`
- Modify: `lib/secrets/store.ts` (factor a `SecretsLocation` so encrypt/decrypt helpers take `{filePath, filenameOverride, cwd}`; public `readSecret/writeSecret/rotateSecret/listSecretNames` signatures unchanged), `commands/secrets.ts` (`--team <slug>` on set/list/rotate; `rotate --team <slug>` with no key = re-encrypt all domains), `lib/command-tree-def.ts` (args), `lib/home/age-key.ts` (export `renderSopsYamlFor(pathRegex: string, recipients: string[]): string`)
- Test: `lib/secrets/__tests__/team-store.test.ts`, extend `lib/secrets/__tests__/store.test.ts` (locations refactor keeps every existing assertion)

**Interfaces:**
- Produces:

```ts
// lib/secrets/team-store.ts
export function teamSecretsFile(slug: string, domain: string): string        // ~/.mattstack/teams/<slug>/mattstack/secrets/<domain>.json
export function teamSopsYamlPath(slug: string): string                        // ~/.mattstack/teams/<slug>/.sops.yaml  (path_regex: mattstack/secrets/.*)
export function readTeamRecipients(slug: string, seams: SecretsSeams): string[]           // parses the age: list (comma/newline separated) — [] when absent
export function writeTeamRecipients(slug: string, recipients: string[], seams: SecretsSeams): void   // renders renderSopsYamlFor("mattstack/secrets/.*", recipients) — sorted, deduped
export async function readTeamSecret(slug: string, domain: string, key: string, seams: SecretsSeams): Promise<string | null>
export async function writeTeamSecret(slug: string, domain: string, key: string, value: string, seams: SecretsSeams): Promise<void>   // requires ≥1 recipient (else throws NoTeamRecipientsError with "run rt team members sync"); cwd pinned to the team clone so sops finds the team .sops.yaml
export async function addTeamRecipient(slug: string, publicKey: string, seams: SecretsSeams): Promise<{ added: boolean; reencrypted: string[] }>   // write recipients, then `sops updatekeys -y <file>` for every domain file
export async function removeTeamRecipient(slug: string, publicKey: string, seams: SecretsSeams): Promise<{ removed: boolean; reencrypted: string[] }>
export async function reencryptTeamSecrets(slug: string, seams: SecretsSeams): Promise<string[]>   // `sops updatekeys -y` per file — the `rt secrets rotate --team` mechanic; note in the command's output that removed members keep their old copies (documented residue)
```
Layout note for the settings lane — already applied to `docs/superpowers/specs/2026-08-21-rt-setup-contract.md` under the "Team-scope secrets layout" heading in the appspec branch (merged to main before this lane executes); this task only references it and commits **no** spec/contract file from the L1 worktree: `teams/<slug>/.sops.yaml` (N `age:` recipients, `path_regex: mattstack/secrets/.*`), files at `teams/<slug>/mattstack/secrets/<domain>.json`, domains `board` (slackClientSecret, slackSigningSecret) and `rt` (switchboardAdminToken, shared service tokens a pack declares).

- [ ] **Step 1: Failing tests** (fake exec seam as in store.test.ts): `writeTeamRecipients` renders a `.sops.yaml` with both keys and the team path_regex; `writeTeamSecret` argv pins `--filename-override mattstack/secrets/board.json` and spawn cwd = team clone (assert via `buildSecretsSpawnOptions`-style builder exported as `buildTeamSpawnOptions(slug)`); zero recipients → throws; `addTeamRecipient` runs `["sops","updatekeys","-y",<file>]` once per existing domain file; `removeTeamRecipient` rewrites without the key and re-encrypts; existing store tests unchanged and green after the locations refactor.
- [ ] **Step 2:** fail. **Step 3:** implement. `rt secrets set <domain> <key> --team <slug>` / `list --team` / `rotate --team <slug> [<domain> <key>]`: with domain+key = rotate that value; with none = `reencryptTeamSecrets`. **Step 4:** green; tsc 0. **Step 5: Commit** `MAT-383: team-scope secrets — N-recipient sops, rotate --team`

---

### Task 14: Invite crypto + code encoding

**Files:**
- Create: `lib/team/invite-crypto.ts`, `lib/team/slug.ts`
- Test: `lib/team/__tests__/invite-crypto.test.ts`, `lib/team/__tests__/slug.test.ts`

**Interfaces:**
- Produces:

```ts
// lib/team/slug.ts
export function slugify(name: string): string   // lowercase, [^a-z0-9]+ → "-", trim "-", max 40; throws UserActionableError("bad-team-name") when empty
// lib/team/invite-crypto.ts  (WebCrypto AES-256-GCM; pinned: 32-byte key, 12-byte IV, ciphertext = base64(iv ‖ ct‖tag))
export const INVITE_ID_BYTES = 16;            // relay ids are 16 random bytes, transported as 32 lowercase hex chars (L6 contract)
export function generateKey(): Uint8Array     // crypto.getRandomValues 32 bytes
export async function seal(pointer: InvitePointer, key: Uint8Array): Promise<string>          // base64 string
export async function open(ciphertextB64: string, key: Uint8Array): Promise<InvitePointer>    // throws UserActionableError("invite-unreadable") on auth failure / bad JSON / v !== 1
export function encodeCode(idHex: string, key: Uint8Array): string      // base32 Crockford (no padding) of idBytes(16)‖key(32) = 77 chars, chunked "XXXXX-XXXXX-…" (groups of 5, dash-separated)
export function decodeCode(code: string): { idHex: string; key: Uint8Array }   // strips dashes/whitespace, case-insensitive, maps Crockford aliases (O→0, I/L→1); throws UserActionableError("invite-malformed") on wrong length/alphabet
export async function sealReply(reply: { v: 1; agePublicKey: string; handle?: string }, key: Uint8Array): Promise<string>   // same AEAD, for the invitee→owner blob
export async function openReply(b64: string, key: Uint8Array): Promise<{ v: 1; agePublicKey: string; handle?: string }>
```

- [ ] **Step 1: Failing tests.** seal→open round-trips a pointer; tampering one byte of the ciphertext → `open` throws with code `invite-unreadable`; wrong key → throws; `encodeCode`/`decodeCode` round-trip with random id/key, lowercased and with dashes removed both decode; a 76-char code → `invite-malformed`; `slugify("Acme Claims!")==="acme-claims"`; `slugify("!!!")` throws.
- [ ] **Step 2:** fail. **Step 3:** implement (`crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt","decrypt"])`; IV via `crypto.getRandomValues(new Uint8Array(12))`). **Step 4:** green; tsc 0. **Step 5: Commit** `MAT-383: opaque invite crypto (AES-256-GCM) + invite code encoding`

---

### Task 15: Relay client

**Files:**
- Create: `lib/team/relay-client.ts`
- Test: `lib/team/__tests__/relay-client.test.ts`

**Interfaces:**
- Produces:

```ts
export const DEFAULT_INVITE_RELAY_URL = "https://switchboard.mattstack.dev";   // overridable: process.env.RT_INVITE_RELAY_URL
export function inviteRelayUrl(env: Record<string, string | undefined>): string
export interface RelayClient {
  create(ciphertext: string, expiresAt: string): Promise<{ id: string; creatorSecret: string }>;    // POST /v1/invites {ciphertext, expiresAt}
  fetch(id: string): Promise<{ ciphertext: string } | "gone">;                                       // GET /v1/invites/:id — 404/410 → "gone"
  redeem(id: string): Promise<"redeemed" | "already">;                                             // POST /v1/invites/:id/redeem — 200 | 409
  reply(id: string, blob: string): Promise<void>;                                                   // POST /v1/invites/:id/reply {blob}
  readReply(id: string, creatorSecret: string): Promise<{ blob: string } | "none">;                 // GET /v1/invites/:id/reply (Authorization: Bearer creatorSecret) — 404 → "none"
  delete(id: string, creatorSecret: string): Promise<void>;                                         // DELETE /v1/invites/:id
}
export function createRelayClient(fetchFn: Probes["fetch"], baseUrl: string): RelayClient   // every non-2xx not listed above → UserActionableError("relay-error", "<status> <path>") ; status 0 → UserActionableError("relay-unreachable")
```
Owner-side persisted mint record (so `members sync` can read replies): `~/.mattstack/rt/invites/<slug>.json` (0600) `{ [handle]: { id, creatorSecret, keyB64, expiresAt } }` — `lib/team/invite-records.ts` with `readInviteRecords(slug)`, `upsertInviteRecord(slug, handle, rec)`, `removeInviteRecord(slug, handle)` (same shape as intent.ts helpers; include in this task).

- [ ] **Step 1: Failing tests** with a fake `fetch` recording `{url, method, body, headers}`: `create` posts JSON and returns id/creatorSecret; `fetch` 410 → "gone"; `redeem` 409 → "already"; `readReply` sends Bearer creatorSecret; 500 → `relay-error`; status 0 → `relay-unreachable`; `inviteRelayUrl({RT_INVITE_RELAY_URL:"http://localhost:9"})` honors the override. Invite records round-trip (0600).
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0. **Step 5: Commit** `MAT-383: invite relay client + owner-side mint records`

---

### Task 16: `rt team create` + `rt team publish`

**Files:**
- Create: `lib/team/create.ts`, `lib/team/publish.ts`, `commands/team.ts`
- Test: `lib/team/__tests__/create.test.ts`, `lib/team/__tests__/publish.test.ts`, `commands/__tests__/team.test.ts`
- Modify: `lib/command-tree-def.ts` (`team` node: create, publish; join/invite/members added by Tasks 17–19), `lib/module-registry.ts` (`./commands/team.ts`)

**Interfaces:**
- Produces:

```ts
// lib/team/create.ts
export interface CreateTeamOpts { name: string; remote: string | null; createRepoOwner?: string; others: boolean }
export interface CreateTeamResult { slug: string; name: string; remote: string; dir: string; created: boolean /* false when the dir already existed with the same remote */ }
export function scaffoldFiles(slug: string, name: string, remote: string): Record<string, string>
//  "mattstack/mattstack.jsonc": { role:"team", namespace:<slug>, org:<owner-from-remote or slug> }
//  "mattstack/settings.jsonc":  { "mattstack.integrations": { forge: forgeFromRemote(remote) }, "board.gitlabHost": <host when gitlab>, "board.projects": [], "board.members": [], "board.title": <name> }   (written as JSONC text with a one-line header comment)
//  ".claude-plugin/marketplace.json": { name: <slug>, owner: { name: <name> }, plugins: [] }
//  ".sops.yaml": renderSopsYamlFor("mattstack/secrets/.*", [])   — recipients filled by members sync / home key
//  ".gitignore": "mattstack/secrets/*.tmp\n.DS_Store\n"
export async function createTeam(p: Probes, opts: CreateTeamOpts): Promise<CreateTeamResult>
//  1. slug = slugify(name); dir = teams/<slug>; if dir exists and its origin URL equals remote → created:false (idempotent); exists with a different remote → UserActionableError("team-exists")
//  2. remote: opts.remote ?? (createRepoOwner ? p.exec(["gh","repo","create",`${owner}/mattstack-team-${slug}`,"--private"]) first stdout line : throw UserActionableError("remote-required", "a git remote is required (gh-created or pasted)"))
//  3. git init -b main; write scaffold files; git add -A; git commit -m "team: scaffold <slug>"; git remote add origin <remote>   (NO push — apply's team.create step pushes)
//  4. write intent {mode:"create", team:{slug,name,remote,others}}
// lib/team/publish.ts
export async function publishTeam(p: Probes, slug: string, remote: string | null): Promise<{ remote: string; pushed: boolean; detail: string }>
//  remote given → `git remote set-url origin <remote>` (or add); then `git push -u origin main`; 128 + auth stderr → UserActionableError("push-denied", message without the URL)
```
`commands/team.ts`: `teamCreate(args)` → `rt team create <name> --remote <url> | --create-repo <owner> [--others] [--json]` prints `envelope(result)`; `teamPublish(args)` → `rt team publish [--team <slug>] --remote <url> [--json]`. Tree: `team: { description: "Team repo: create, join, invite, publish, members", subcommands: { create: {...}, publish: {...} } }`.

- [ ] **Step 1: Failing tests.** `scaffoldFiles("acme","Acme","https://gitlab.example.com/g/acme.git")` → settings has `mattstack.integrations.forge.host==="gitlab.example.com"` and `board.gitlabHost`; github remote → no `board.gitlabHost` key; `createTeam` records argv sequence `git init -b main` → (writes) → `git add -A` → `git commit` → `git remote add origin`, never `push`; intent written; missing remote without createRepoOwner → `remote-required`; `--create-repo o` → `gh repo create o/mattstack-team-acme --private` and the printed URL becomes the remote; second call same remote → `created:false` and zero git calls. `publishTeam` runs `set-url` then `push -u origin main`; auth failure message excludes the URL.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0; registry test. **Step 5: Commit** `MAT-383: rt team create|publish — scaffolded team zone, push at Install`

---

### Task 17: `rt team invite` (mint) + forge grant

**Files:**
- Create: `lib/team/forge.ts`, `lib/team/invite.ts`
- Modify: `commands/team.ts` (`teamInvite`), `lib/command-tree-def.ts` (`team invite`)
- Test: `lib/team/__tests__/forge.test.ts`, `lib/team/__tests__/invite.test.ts`

**Interfaces:**
- Produces:

```ts
// lib/team/forge.ts
export type ForgeAccess = "granted" | "manual" | "skipped";
export async function grantRead(p: Probes, remote: string, handle: string): Promise<{ access: ForgeAccess; manualSteps: string[] }>
//  github: p.exec(["gh","api","-X","PUT",`/repos/${owner}/${repo}/collaborators/${handle}`,"-f","permission=pull"]) code 0 → granted; 127/non-0 → manual with steps ["Open https://github.com/<o>/<r>/settings/access","Invite <handle> with Read"]
//  gitlab: id = p.exec(["glab","api",`users?username=${handle}`]) → [{id}]; p.exec(["glab","api","-X","POST",`projects/${encodeURIComponent(path)}/members`,"-f",`user_id=${id}`,"-f","access_level=20"]) → granted; else manual steps for the GitLab members page
//  unparsable remote → skipped
export async function revokeRead(p: Probes, remote: string, handle: string): Promise<{ access: ForgeAccess; manualSteps: string[] }>   // DELETE collaborator / members/<id>
export async function forgeLogin(p: Probes, provider: "github" | "gitlab", host: string): Promise<string | null>   // gh api user → login ; glab api user → username
// lib/team/invite.ts
export const INVITE_TTL_DAYS = 7;
export function pasteBlock(code: string, downloadUrl = "https://github.com/m4ttstack/rt/releases/latest"): string
//  `Install mattstack from ${downloadUrl}, then open mattstack://join/${code} or paste the code into Setup → Join a team.\n\nInvite code:\n${code}`
export interface InviteResult { code: string; expiresAt: string; pasteBlock: string; forgeAccess: ForgeAccess; manualSteps: string[] }
export async function mintInvite(p: Probes, relay: RelayClient, opts: { slug: string; handle: string; now: Date }): Promise<InviteResult>
//  1. snapshot = readTeamSnapshot(p, slug); remote required (UserActionableError("no-team-remote")); owner = forgeLogin(...) ?? p.env.USER
//  2. pointer = {v:1, team:slug, name:<board.title or slug>, remote, owner, forge:host, createdAt}
//  3. existing record for handle → relay.delete(old id, creatorSecret) (replace-on-mint; ignore "gone")
//  4. key = generateKey(); ct = seal(pointer,key); {id, creatorSecret} = relay.create(ct, expiresAt= now+7d)
//  5. grantRead(...); roster: setSetting("board.members", [...existing, {username: handle}], "team", {team: slug}) unless already present
//  6. upsertInviteRecord(slug, handle, {id, creatorSecret, keyB64, expiresAt}); return {code: encodeCode(id,key), ...}
```
`commands/team.ts`: `teamInvite(args)` → `rt team invite --handle <h> [--team <slug>] [--json]`; human output prints the paste block and the manual steps when `forgeAccess !== "granted"`.

- [ ] **Step 1: Failing tests.** forge: github remote → exact gh argv; gitlab → users lookup then members POST with `access_level=20`; gh 127 → manual with the settings URL. invite: fake relay records `create` body has `ciphertext` (base64, not containing "remote" or the host plaintext — assert `!body.includes(host)`), `expiresAt` = now+7d ISO; roster write via a `writeSetting` seam spied to receive `board.members` with the handle appended; replace-on-mint deletes the prior id; result code decodes back to the relay id and opens the pointer; paste block contains `mattstack://join/`.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0. **Step 5: Commit** `MAT-383: rt team invite — opaque relay invite, forge grant at mint`

---

### Task 18: `rt team join` (dry-run + redeem)

**Files:**
- Create: `lib/team/join.ts`
- Modify: `commands/team.ts` (`teamJoin`), `lib/command-tree-def.ts` (`team join`)
- Test: `lib/team/__tests__/join.test.ts`, `commands/__tests__/team-join.test.ts`

**Interfaces:**
- Produces:

```ts
export interface JoinResult { team: { slug: string; name: string; owner: string }; access: "ok" | "denied" | "unreachable"; peering: "applied" | "idle" | "unavailable"; message: string }
export async function joinDryRun(p: Probes, relay: RelayClient, code: string): Promise<JoinResult>
//  decodeCode → relay.fetch(id) ("gone" → UserActionableError("invite-unknown", "invite not recognized or expired: ask the team owner for a new one")) → open(ct,key) (bad → same message) → git ls-remote --exit-code <pointer.remote> HEAD (GIT_TERMINAL_PROMPT=0):
//  0/2 → access ok; auth stderr → "denied" with message "you don't have access yet: ask <owner> to grant you access to <name>" (no URL, no git output); else "unreachable"
//  on ok: writeIntent({mode:"join", join:{id, keyB64, pointer}}); peering:"idle" (dry-run never applies); message "Joining <name> (owner <owner>)"
export async function joinRedeem(p: Probes, relay: RelayClient, secrets: SecretsSeams, opts: { code?: string }): Promise<JoinResult>
//  source = opts.code ? decode+fetch+open : readIntent().join (UserActionableError("no-join-intent") when neither)
//  1. clone: dir = teams/<pointer.team>; exists with same origin → skip; else `git clone <remote> <dir>`; auth failure → access denied result (exit 2 payload carries it)
//  2. relay.redeem(id) → "already" → UserActionableError("invite-used", "this invite was already used: ask <owner> for a new one") — but only when the clone did NOT already exist (re-running after a crash must not brick)
//  3. materialize: claude.marketplaces/claude.plugins from the team store are applied by apply's plugins.install step (not here); `rt skills materialize` runs in apply; here only record intent done
//  4. peering: snapshot.integrations.switchboard?.url and a team secret rt.switchboardAdminToken readable (readTeamSecret) → POST <url>/peer/join {member: forgeLogin} with Bearer admin token → "applied"; url absent → "idle"; request fails → "unavailable"
//  5. reply blob: publicKey from ensureAgeKey (lib/home/age-key.ts — mints if absent; requires keychain) → sealReply({v:1, agePublicKey, handle: forgeLogin}, key) → relay.reply(id, blob)
//  6. clearIntent() only when called from apply (opts.fromApply) — the CLI form clears at the end too
```
`commands/team.ts`: `teamJoin(args)` → `rt team join [--dry-run] [--json]`; code from stdin JSON `{"code"}` or a no-echo prompt on TTY; **never from argv** (an argv code → UserActionableError("code-on-argv", "pass the invite code on stdin, never as an argument")). Tree: `join: { description: "Redeem an invite (code on stdin, never an argument)", args: [{flag:"--dry-run"...}, json] }`.

- [ ] **Step 1: Failing tests.** dry-run: fake relay returns the sealed pointer → result `access:"ok"`, message "Joining Acme (owner matt)", intent written with the pointer and key; relay "gone" → `invite-unknown`; ls-remote auth stderr → `access:"denied"`, message has no URL; redeem: `git clone` argv recorded; `relay.redeem` called after clone; reply blob posted (fake relay records; `openReply` with the key yields the fake public key); switchboard url + admin token → `peering:"applied"` with `POST <url>/peer/join`; no url → "idle"; `teamJoin(["ABC"])` → exit 2 `code-on-argv`.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0. **Step 5: Commit** `MAT-383: rt team join — dry-run validation, redeem, reply key exchange, peering`

---

### Task 19: `rt team members sync|remove` + `rt team status`

**Files:**
- Create: `lib/team/members.ts`
- Modify: `commands/team.ts` (`teamMembersSync`, `teamMembersRemove`, `teamStatus`), `lib/command-tree-def.ts` (`team members sync|remove`, `team status`)
- Test: `lib/team/__tests__/members.test.ts`, `commands/__tests__/team-status.test.ts`

**Interfaces:**
- Produces:

```ts
export async function membersSync(p: Probes, relay: RelayClient, secrets: SecretsSeams, slug: string): Promise<{ added: string[]; pending: string[]; reencrypted: string[] }>
//  for each invite record: relay.readReply(id, creatorSecret) → openReply(blob, key) → addTeamRecipient(slug, agePublicKey) → removeInviteRecord; "none" → pending
//  also ensures the OWNER's own key is a recipient (ensureAgeKey publicKey) — a fresh team has zero recipients until this runs
export async function membersRemove(p: Probes, secrets: SecretsSeams, slug: string, handle: string, agePublicKey?: string): Promise<{ forgeAccess: ForgeAccess; manualSteps: string[]; reencrypted: string[]; rosterRemoved: boolean; residueNote: string }>
//  revokeRead(remote, handle); roster: setSetting board.members without the handle; recipient: removeTeamRecipient when agePublicKey given (else when the roster entry carries `agePublicKey` — membersSync stores it on the roster entry {username, agePublicKey}); reencryptTeamSecrets; residueNote = "Removed members keep any secrets they already decrypted; rotate the values themselves with `rt secrets rotate --team <slug> <domain> <key>`."
```
Tree: `members: { description: "Roster: collect invitee keys / remove a member", subcommands: { sync: {fn:"teamMembersSync", args:[team, json]}, remove: {fn:"teamMembersRemove", args:[{name:"Handle", type:"text"}, team, json]} } }`.

`teamStatus(args)` → `rt team status [--team <slug>] --json` (the app's Settings → Team pane reads it; contract verb) prints `envelope({ slug, name, remote, lastPush, members: [{username}] })`: `slug`/`name` from `readTeamSnapshot` (`name` = `board.title` ?? slug), `remote` = the raw origin URL (masking is the app's job), `lastPush` = `p.exec(["git","-C",teams/<slug>,"log","-1","--format=%cI","origin/main"])` stdout trimmed or `null` when it fails, `members` = `getSetting("board.members").value ?? []` mapped to `{username}`; no team cloned → UserActionableError("no-team"). Tree node `team.status: { description: "Team summary (name, remote, last push, members)", fn: "teamStatus", args: [team, json] }`.

- [ ] **Step 1: Failing tests.** sync with one record whose reply exists → `added:["<key>"]`, `sops updatekeys` called, record removed; no reply → pending; owner key always present afterwards. remove → revoke argv, roster write without the handle, updatekeys run, residueNote non-empty. `team-status.test.ts`: `teamStatus(["--json"])` with a fake snapshot + `git log` stdout `2026-08-21T10:00:00+00:00` → envelope `{slug, name, remote, lastPush, members:[{username:"matt"}]}`; `git log` failing → `lastPush:null`; no team → exit 2 `no-team`.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0; registry. **Step 5: Commit** `MAT-383: rt team members sync|remove + team status — recipients follow the roster`

---

### Task 20: `rt repos register`, `rt skills materialize`, `rt cron install`

**Files:**
- Create: `commands/repos.ts`, `commands/skills.ts`, `commands/cron.ts`, `lib/setup/skills-materialize.ts`, `lib/setup/cron-install.ts`
- Modify: `lib/command-tree-def.ts` (`repos`, `skills`, `cron` nodes), `lib/module-registry.ts` (three entries)
- Test: `commands/__tests__/repos.test.ts`, `lib/setup/__tests__/skills-materialize.test.ts`, `lib/setup/__tests__/cron-install.test.ts`

**Interfaces:**
- Produces:

```ts
// commands/repos.ts
export async function reposRegister(args: string[], _ctx?: CommandContext, deps = realRegisterDeps()): Promise<void>
//  rt repos register <path…> [--track live|poll] [--caches branches,project-mrs] [--json]
//  per path: name = basename(realpath); updateRepoIndex(name, path) (lib/repo-index.ts); --track → loadRepoTracking()/saveRepoTracking() with {mode, caches} (signatures stable across the keys wave); prints envelope({registered:[{name,path,tracking}]})
// lib/setup/skills-materialize.ts
export function findMergeManifests(p: Pick<Probes,"readDir"|"exists"|"home"|"env">): string | null
//  RT_MERGE_MANIFESTS env, else highest semver dir under ~/.claude/plugins/cache/mattstack/mattstack/*/plugin/skills/parameterized-skills/scripts/merge-manifests.sh
export async function materializeSkills(p: Probes, opts: { repo?: string }): Promise<{ repos: { name: string; path: string; ok: boolean; detail: string }[] }>
//  targets = opts.repo ? [that registered repo] : getKnownRepos(); for each: p.exec(["bash", script, "--repo", path], {env:{MATTSTACK_HOME: ~/.mattstack}}) — exit 2 ("no git remote") → ok:false detail from stderr (not fatal); script missing → UserActionableError("merge-manifests-missing", "install the mattstack plugin first (plugins.install)")
// commands/skills.ts: skillsMaterialize(args) → rt skills materialize [--repo <name>] [--json]
// lib/setup/cron-install.ts
export interface TriageTrigger { name: "board-triage"; event: "project-mrs"; run: string[]; debounceMs: 5000 }
export function triageTrigger(boardBinary: string): TriageTrigger   // run: [boardBinary, "triage", "--once"]
export function installCronTrigger(trigger: { name: string; event: string; run: string[]; repoName?: string; debounceMs?: number }): { written: boolean; reason?: string }
//  def = getDef("rt.cron"); !isMigrated(def) → {written:false, reason:"rt.cron is not migrated to the settings stores yet (settings lane in flight)"}; else current = getSetting("rt.cron").value ?? {triggers:[]}; replace-by-name; setSetting("rt.cron", {triggers}, "machine"); print "restart the daemon to apply: rt daemon restart"
// commands/cron.ts: cronInstall(args) → rt cron install <trigger> [--json]  (trigger ∈ "board-triage"; binary from resolveTool(p,"board").chosen — UserActionableError("board-missing") when null)
```
Tree nodes: `repos: { description: "Register repos with rt (index + tracking)", subcommands: { register: {...} } }`; `skills: { description: "Skill bindings", subcommands: { materialize: {...} } }`; `cron: { description: "Daemon cron triggers", subcommands: { install: { args:[{name:"Trigger", type:"select", options:[{value:"board-triage", label:"board-triage"}]}, json] } } }`.

- [ ] **Step 1: Failing tests.** `reposRegister` with a temp git repo under the test HOME → repos.json (test HOME) contains the name; `--track poll --caches branches,project-mrs` → `loadRepoTracking()` shows the entry. `findMergeManifests` picks `0.4.1` over `0.3.1` from fake dirs; `materializeSkills` records `bash <script> --repo <path>` with `MATTSTACK_HOME`. `installCronTrigger` when `isMigrated(getDef("rt.cron"))` is false → `{written:false}` (spy `isMigrated` via a seam param `deps.isMigrated`); when true → `setSetting` seam called with machine scope and the trigger replaced by name.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0; registry test. **Step 5: Commit** `MAT-383: rt repos register, rt skills materialize, rt cron install`

---

### Task 21: `rt tools install|setup`

**AFTER L1 T5 and L4 T11 merge** (uses `resolveTool(...).exec` / `link` from Task 5).

**Files:**
- Create: `lib/setup/tools-install.ts`, `commands/tools.ts`
- Modify: `lib/command-tree-def.ts` (`tools` node), `lib/module-registry.ts`
- Test: `lib/setup/__tests__/tools-install.test.ts`

**Interfaces:**
- Produces:

```ts
export const VENDOR_INSTALLERS: Record<string, string[]> = {
  herdr:  ["sh","-c","curl -fsSL https://herdr.dev/install.sh | sh"],
  claude: ["sh","-c","curl -fsSL https://claude.ai/install.sh | bash"],
};
export const BREW_FORMULAE: Record<string, string> = { herdr: "herdr", claude: "claude-code" };
export async function installTool(p: Probes, tool: string, reqs: PackRequirements[]): Promise<{ via: "brew" | "vendor" | "apple-clt" | "bundled-link"; ok: boolean; detail: string }>
//  apple-clt → p.exec(["xcode-select","--install"]) (code 1 "already installed" → ok)
//  bundledToolExec(p, tool) non-null (the bundle's deps.lock lists it) → link(p, tool) (via bundled-link)
//  brew present (p.exec(["brew","--version"]) code 0) and formula known (BREW_FORMULAE or reqs tool.install.brew) → ["brew","install",formula]
//  else VENDOR_INSTALLERS[tool] or reqs tool.install.url → ["sh","-c",`curl -fsSL ${url} | sh`]
//  else UserActionableError("no-installer", "no install method known for <tool>")
export async function setupTool(p: Probes, tool: string, opts: { configDirs: string[] }): Promise<{ ok: boolean; detail: string }>
//  "fast-browser": p.exec([...resolveTool(p,"fast-browser").exec!, "setup"]) — the exec argv prefix ([node, fast-browser.mjs] when bundled), never `chosen` as argv0 (UserActionableError("tool-missing") when exec is null)
//  "herdr": for each dir: p.exec(["herdr","integration","install","claude"], {env:{CLAUDE_CONFIG_DIR: dir}})
//  "extension": installExtensionsHeadless(p) — moved from commands/post-install.ts's installExtensions (vsix found at `<appPath>/Contents/Resources/rt-context.vsix` first, then next to the binary) — returns installed editor names and records them in setup-state
//  else UserActionableError("unknown-tool-setup")
export function claudeConfigDirs(p: Pick<Probes,"env"|"home">, extra: string[]): string[]   // [CLAUDE_CONFIG_DIR env ?? ~/.claude, ...extra] deduped
```
`commands/tools.ts`: `toolsInstall(args)` → `rt tools install <tool> [--json]`; `toolsSetup(args)` → `rt tools setup <tool> [--config-dir <dir>]… [--json]`.

- [ ] **Step 1: Failing tests.** herdr with brew present → `brew install herdr`; without brew → the vendor sh -c line; team tool with `install.brew` → that formula; `gh` → link via bundled-link; apple-clt → xcode-select argv; `setupTool("fast-browser")` with `exec=[node, mjs]` records argv `[node, mjs, "setup"]`; `setupTool("herdr",{configDirs:[a,b]})` runs twice with the env var; extension setup records editors in setup-state.
- [ ] **Step 2:** fail. **Step 3:** implement (`detectEditors` imported from commands/extension.ts; the headless vsix install uses `p.exec([cli,"--install-extension",vsix,"--force"],{timeoutMs:30000})`). **Step 4:** green; tsc 0; registry test. **Step 5: Commit** `MAT-383: rt tools install|setup — brew/vendor/CLT installs, tool-owned setup`

---

### Task 22: `rt services` facade + need protocol

**Files:**
- Create: `commands/services.ts`, `lib/setup/need.ts`
- Modify: `lib/command-tree-def.ts` (`services` node), `lib/module-registry.ts`
- Test: `commands/__tests__/services.test.ts`, `lib/setup/__tests__/need.test.ts`

**Interfaces:**
- Produces:

```ts
// commands/services.ts — every verb: tray status 0 → UserActionableError("app-not-running", "mattstack.app is not running — open it, then retry")
export async function servicesList(args, _ctx?, deps = realServicesDeps()): Promise<void>       // GET /services → envelope({agents})
export async function servicesRegister(args, _ctx?, deps?): Promise<void>                          // --plist <name> (repeatable; default servicePlists(currentMode(), p)) → POST /services/register {plists}
export async function servicesRestart(args, _ctx?, deps?): Promise<void>                           // <label> → POST /services/restart {label}
// lib/setup/need.ts
export const SERVICE_PLISTS = ["com.mattstack.daemon.plist", "com.mattstack.deck.plist"] as const;   // dev flavor: ".dev" inserted before ".plist" when currentMode()==="dev"
export function servicePlists(mode: "dev" | "prod", p: Pick<Probes, "exists" | "home">): string[]  // lives here (lib), consumed by commands/services.ts and steps/services.ts
//  daemon plist always; the deck plist ONLY when `resolveTool(p,"deck").chosen` is non-null (deck bundled) — otherwise it is omitted and the caller logs "deck not bundled yet — only the daemon is registered" (the app reports ok only when every requested plist registers, so a missing helper must not be requested)
export interface NeedReply { ok: boolean; detail?: string }
/**
 * rt emits the need event on stdout, then polls GET /setup/need/<id> on tray.sock. The app always answers 200
 * {state: "pending" | "done" | "failed", detail?} (unknown/unstarted ids are "pending"); rt keeps polling while
 * state is "pending" (a 404 is tolerated as pending too), maps "done" → {ok:true, detail} and "failed" →
 * {ok:false, detail}. Works identically whether the app answers instantly or holds the GET open.
 */
export async function awaitNeed(tray: TrayClient, id: StepId, opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<NeedReply | "timeout" | "app-gone">
//  timeoutMs default 600_000; pollMs 1_000; each GET timeoutMs 30_000; status 0 three times in a row → "app-gone"
```
Tree: `services: { description: "App-registered services (daemon, deck) via mattstack.app", subcommands: { list, register, restart } }`.

- [ ] **Step 1: Failing tests.** list with fake tray → envelope with agents; tray 0 → exit 2 `app-not-running`; register default plists body; `servicePlists("dev", p)` with deck resolvable → `com.mattstack.daemon.dev.plist`, `com.mattstack.deck.dev.plist`; with deck not bundled → only `com.mattstack.daemon.dev.plist`. need: fake tray returns 200 `{state:"pending"}` twice then 200 `{state:"done", detail:"registered"}` with a fake sleep → `{ok:true, detail:"registered"}`; 200 `{state:"failed", detail:"denied"}` → `{ok:false, detail:"denied"}`; a 404 followed by `done` → reply (404 tolerated as pending); always `pending` with fake clock past 10 min → "timeout"; status 0 ×3 → "app-gone".
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0; registry. **Step 5: Commit** `MAT-383: rt services facade + need-event wait over tray.sock`

---

### Task 23: Apply engine

**Files:**
- Create: `lib/setup/apply.ts`, `lib/setup/steps/index.ts` (ordered registry; step bodies come in Tasks 24–26 — this task registers a `stubStep(id,title,kind)` for each id that returns `{state:"skipped", detail:"not implemented"}` so the engine is testable; each later task REPLACES its stubs)
- Test: `lib/setup/__tests__/apply.test.ts`

**Interfaces:**
- Produces:

```ts
export type StepOutcome = { state: "done"; detail?: string } | { state: "skipped"; detail: string } | { state: "failed"; detail: string; remedy?: string };
export interface ApplyContext {
  p: Probes; emit: Emit; log(id: StepId, line: string): void;
  intent: SetupIntent | null; team: TeamRef; snapshot: TeamSnapshot | null; reqs: PackRequirements[];
  nonInteractive: boolean; teamOfOne: boolean; appPath: string | null; ci: boolean;
  secrets: SecretsSeams; relay: RelayClient;
  need(id: StepId, request: NeedRequest): Promise<NeedReply | "timeout" | "app-gone" | "no-app">;   // no-app when tray unreachable and nonInteractive → steps skip honestly
}
export interface StepDef { id: StepId; title: string; kind: StepKind; applies(ctx: ApplyContext): boolean; run(ctx: ApplyContext): Promise<StepOutcome> }
export const STEPS: StepDef[]   // contract order; exactly one def per STEP_IDS entry (test asserts)
export async function runApply(ctx: ApplyContext, opts: { from?: StepId }): Promise<{ ok: boolean; failedStep?: StepId }>
//  steps = STEPS.filter(s => s.applies(ctx)); emit plan; for each: before `from` → emit step skipped "before --from"; else emit running → run → emit outcome; failed → emit done {ok:false, failedStep}, return; after all → updateSetupState lastApplyAt, clearIntent when ok, emit done {ok:true}
//  a step that THROWS: UserActionableError → failed {detail: message, remedy: extra.remedy}; other Error → failed {detail:`bug: ${message}`} and rethrow AFTER emitting done (exit 1 semantics preserved)
export function createApplyContext(deps: { probes: Probes; emit: Emit; secrets: SecretsSeams; relay: RelayClient; flags: { nonInteractive: boolean; teamOfOne: boolean; ci: boolean } }): Promise<ApplyContext>
```

- [ ] **Step 1: Failing tests.** With a test-only STEPS override (export `runApplyWith(steps, ctx, opts)`): three fake steps → events in order `plan, step running, step done, …, done ok:true`; second step fails → third never runs, `done {ok:false, failedStep}`; `--from` second → first emitted skipped "before --from"; a step throwing `UserActionableError("x","msg",{remedy:"do y"})` → failed with remedy; a step throwing `Error` → done emitted then rethrown; `STEPS.map(s=>s.id)` deep-equals `STEP_IDS`.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0. **Step 5: Commit** `MAT-383: apply engine — NDJSON stream, resume, stop-on-fail`

---

### Task 24: Apply steps A — home, team, secrets, path, intercepts, settings, repos

**AFTER L4 T9 merges** (`bundleRootFromExec` from `lib/bundle-layout.ts` (L4 T1), `installRtBinary` from `lib/dev-mode.ts`, `legacyUserAppPath` from `lib/rt-paths.ts`; rebase onto `origin/main` first).

**Files:**
- Create: `lib/setup/steps/home.ts`, `steps/team.ts`, `steps/secrets.ts`, `steps/path.ts`, `steps/settings.ts`, `steps/repos.ts`
- Modify: `lib/setup/steps/index.ts` (replace stubs), `lib/shell-integration.ts` (add `ZSHENV_MARKER`, `installZshenvPrecedence()`, `removeShellIntegration()`, `removeZshenvPrecedence()`; an END marker `# rt — end` is now appended to new blocks)
- Test: `lib/setup/__tests__/steps-a.test.ts`, `lib/__tests__/shell-integration-remove.test.ts`

Step bodies (exact):

- `home.init` (kind rt; applies: `intent?.mode !== "restore"`): `p.exists(~/.mattstack/.git)` and `readAgeKey` has key → done "already initialized"; else `p.runRt(["home","init"])` (gh path) → code 0 → done (detail last stdout line); else failed, detail stderr head, remedy "Run `gh auth login`, then Retry".
- `home.restore` (applies: mode restore): **verifier only** — the app (L3 T13) runs the real `rt restore <org>/<repo>` (age key on stdin `{"ageKey"}`) when the user presses Continue on the restore card and then `rt setup intent restore <org>/<repo>`; this step checks that the clone exists (`~/.mattstack/.git` with origin containing `intent.restore.homeRepo`) and the key is present → done "restored"; else failed, remedy "Run `rt restore <org>/<repo>` (pastes your age key), then Retry" — never runs restore itself.
- `team.create` (applies: mode create OR (teamOfOne && no intent && teams=[])): teamOfOne without intent → `createTeam(p, { name: p.env.RT_TEAM_NAME ?? "personal", remote: p.env.RT_TEAM_REMOTE ?? null, createRepoOwner: p.env.RT_TEAM_REMOTE ? undefined : (await forgeLogin(p,"github","github.com")) ?? undefined, others:false })`; then `publishTeam(p, slug, null)`; failed with remedy on `push-denied`. **Team-of-one with no remote source** (no `RT_TEAM_REMOTE` and `forgeLogin` null because gh is not authenticated — the headless clean-room job) → **skipped** "no git remote available (set RT_TEAM_REMOTE or run gh auth login)" instead of failed, so the run reaches `verify`; `remote-required` is a failure only when an intent explicitly asked for create.
- `team.join` (applies: mode join): `joinRedeem(p, ctx.relay, ctx.secrets, {fromApply:true})`; access denied → failed "you don't have access yet: ask <owner>…", remedy "Ask the owner to grant access, then Retry".
- `secrets.write`: `drainStaged(p, (d,k,v) => writeSecret(d,k,v,ctx.secrets))` → done "N staged secrets written" (0 → done "nothing staged"); `NoAgeKeyError` → failed remedy "home.init did not mint a key — Retry from home.init".
- `path.link`: for tool of DEFAULT_EXPOSED: `link(p, tool)` (rt → `installRtBinary`'s atomic symlink; multi-argv tools → tagged wrapper; dev-mode-owns-rt → log line, not failure; user-copy → skipped per tool with log line); `installShellIntegration()`; `installZshenvPrecedence()` (writes to `~/.zshenv`: `# mattstack — PATH precedence` + `export PATH="$HOME/.local/bin:$PATH"` + end marker, idempotent); done detail "linked: a,b · skipped: c".
- `intercepts.install`: `installShims()` → done "N shims" ("no commands to shim" when 0).
- `settings.seed`: `mattstack.appPath` ← `ctx.appPath` (derived: `bundleRootFromExec()` from `lib/bundle-layout.ts` (L4 T1) — no regex of our own — else `getSetting` value if present, else `installedTrayAppPath`) via `setSetting("mattstack.appPath", path, "machine")` when non-null; a transient root (`root.startsWith("/Volumes/") || root.includes("/AppTranslocation/")` — the DMG or a translocated copy, ported from L4's `appPathIsTransient`) is **refused**: in apply → failed "running from <root> — drag mattstack.app to /Applications, then Retry" (remedy "Move mattstack.app to /Applications and relaunch it"), never written; `rt --post-install` exits 2 on it (Task 27); `rt.repoRoots` ← existing ?? detected roots (`~/Documents/GitHub`, `~/GitHub`, `~/code`, `~/src` that exist) via setSetting machine (only when currently unset); done lists what was written.
- `repos.clone`: root = `getSetting("rt.repoRoots").value?.[0]` (failed "no repo root" otherwise); for each identity in `snapshot.trackingIdentities` (minus `p.env.RT_SKIP_REPOS` comma list — the deselect channel): dest = `<root>/<basename>`; exists → log "present"; else `git clone https://<identity>.git <dest>` (auth failure → log + continue; counted); then `updateRepoIndex(basename, dest)`; done "cloned N, present M, failed K" (failed>0 → still done; detail says so — tracking activates only for resolvable clones).

- [ ] **Step 1: Failing tests** (fake probes + seams; setSetting against the test HOME): `home.init` runs `runRt(["home","init"])` only when `.git` missing; `path.link` records symlinks for fast-browser/gitq/deck and skips `rt` in dev mode; `.zshenv` gets the precedence block once (second call no duplicate); `removeShellIntegration()` strips the block written by `installShellIntegration()` exactly (before/after equality on a fixture with unrelated lines) and returns `{removed:false, manual:true}` for a legacy block without end marker; `settings.seed` writes `mattstack.appPath` (read back via getSetting) from an execPath inside a bundle (inject `bundleRootFromExec` via a seam), and with root `/Volumes/mattstack/mattstack.app` → failed with the drag-to-Applications remedy and nothing written; `team.create` under `teamOfOne` with no `RT_TEAM_REMOTE` and gh unauthenticated → skipped with the "no git remote available" detail; `repos.clone` argv `git clone https://gitlab.com/acme/acme-dev.git <root>/acme-dev` and skips an existing dir; `secrets.write` drains staged values through a fake writer.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0. **Step 5: Commit** `MAT-383: apply steps — home, team, secrets, path, intercepts, settings, repos`

---

### Task 25: Apply steps B — services.register, proxy.install, deck.managed, skills.materialize, board.keys, cron.triage

**Files:**
- Create: `lib/setup/steps/services.ts`, `steps/deck.ts`, `steps/skills.ts` (skills.materialize + board.keys + cron.triage live here with skills-materialize/cron-install helpers)
- Test: `lib/setup/__tests__/steps-b.test.ts`

Step bodies:
- `services.register` (kind app): `ctx.need("services.register", {type:"app-register-services", plists: servicePlists(currentMode(), p)})` — the daemon plist always, the deck plist only when `resolveTool(p,"deck").chosen` is non-null (else `ctx.log` "deck not bundled yet — only the daemon is registered"; the app answers `ok:false` for a plist whose `BundleProgram` is missing, so it must not be requested) → reply ok → done (detail); `"no-app"` → skipped "mattstack.app not running — open it to register services" (nonInteractive) or failed with remedy "Open mattstack.app, then Retry" (interactive); "timeout"/"app-gone" → failed remedy "Retry with mattstack.app running"; then `markDaemonInstalled()` (lib/daemon-config.ts) on done.
- `proxy.install` (kind privileged): `need(…, {type:"app-privileged", op:"proxy-install"})` same handling; the app runs the bundled installer helper (L3/L5) — rt only waits.
- `deck.managed`: deck = `resolveTool(p,"deck").chosen` (null → skipped "deck not bundled yet"); for app of `[{name:"board", hostname:"board.mattstack", bin: resolveTool(p,"board").chosen}, {name:"gitq", hostname:"gitq.mattstack", bin: resolveTool(p,"gitq").chosen}]`: bin null → log skip; else `p.exec([deck,"add",name,"--cmd",bin,"--managed-by","mattstack","--host",hostname])` — exit code 0 or stderr /already/ → ok; done "registered: board, gitq". (MAT-384 argv is stubbed behind this one call site; a test pins the argv so the change is one line.)
- `skills.materialize`: `materializeSkills(p,{})` → done with per-repo summary; `merge-manifests-missing` → skipped "mattstack plugin not installed yet" (plugins.install runs later; `rt skills materialize` is re-run by the verify step? No — honest: skipped with detail; `rt setup pack` re-materializes).
- `board.keys`: machine-scope keys: `board.rtRepos` ← names of registered repos whose identity ∈ tracking; `board.cwds` ← `{ review: <root>/<first repo>, respond: same, doctor: same }` only when unset; `gitq.board` ← `{ repos: [...same names], port: 11008 }` when unset; `gitq.workSlots` ← `{ workSlotLocation: <root>/.gitq-slots, maxWorkSlots: 3 }` when unset — every write via `setSetting(key, value, "machine")`, each guarded by `getDef(key)` existing and `isMigrated` (missing def → log "key not in registry yet" and continue); done lists written keys.
- `cron.triage`: applies when `getSetting("board.triage").value?.enabled === true` (key from the board lane; `getDef` missing → skipped "board.triage not registered"); `installCronTrigger(triageTrigger(resolveTool(p,"board").chosen!))` → done / skipped with its reason.

- [ ] **Step 1: Failing tests.** services.register: fake `need` returning `{ok:true}` → done and daemon.json written in test HOME; with deck not bundled the need request's `plists` holds only the daemon plist and a log line mentions "deck not bundled"; "no-app" + nonInteractive → skipped; interactive → failed with remedy. deck.managed: argv pinned for both apps; board missing → detail names only gitq. board.keys: writes `board.rtRepos` via setSetting (read back) and skips `board.cwds` when already set. cron.triage: `board.triage` unset → skipped.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0. **Step 5: Commit** `MAT-383: apply steps — services, proxy, deck managed apps, skills, board/gitq keys, triage cron`

---

### Task 26: Apply steps C — plugins, fast-browser, herdr, extension, services.start, snapshot.push, verify

**Files:**
- Create: `lib/setup/steps/plugins.ts`, `steps/tools.ts`, `steps/verify.ts`
- Test: `lib/setup/__tests__/steps-c.test.ts`

Step bodies:
- `plugins.install`: claude present (`resolveTool`/PATH) else failed remedy "Install Claude Code (Tools row), then Retry". marketplaces = `getSetting("claude.marketplaces").value ?? []` ∪ `[MATTSTACK_MARKETPLACE_SOURCE]` (constant `"https://github.com/m4ttstack/mattstack-marketplace"`, overridable by `RT_MATTSTACK_MARKETPLACE` — see open question 13) ∪ (team slug ? [`~/.mattstack/teams/<slug>`] : []); plugins = `getSetting("claude.plugins").value ?? []` ∪ `["mattstack@mattstack","fast-browser@mattstack"]` ∪ team marketplace plugins (parse `teams/<slug>/.claude-plugin/marketplace.json` → `<plugin.name>@<marketplace.name>`). For each config dir (`claudeConfigDirs(p, [])`): `claude plugin marketplace add <src>` (stderr /already/ → ok), `claude plugin install <p>` (already → ok), `claude plugin enable <p>` (unknown subcommand → ignore). Record in setup-state. Any non-already failure → failed, detail "claude plugin install exited N", remedy "Open Claude Code once so it finishes first-run, then Retry." (the contract's example).
- `fastbrowser.setup`: `setupTool(p,"fast-browser",…)` (spawns `[...resolveTool(p,"fast-browser").exec, "setup"]`) → done/failed (remedy: "Run `fast-browser setup` in a terminal for details"); `exec` null → skipped "fast-browser not bundled".
- `herdr.integration`: herdr on PATH → `setupTool(p,"herdr",{configDirs})` → done; missing → skipped "herdr not installed (Tools row)".
- `extension.install`: `setupTool(p,"extension",…)` → done "installed in …" / skipped "no editor found" / vsix missing → skipped "extension not bundled".
- `services.start`: `p.tray("/daemon/start",{method:"POST"})` status 200 → poll `isDaemonRunning()` up to 12×250 ms → done "daemon running" / failed remedy "Approve the background item in Login Items, then Retry"; tray 0 → nonInteractive ? skipped : failed remedy "Open mattstack.app".
- `snapshot.push`: `p.runRt(["home","snapshot","push"])` when that verb exists in the tree (`TREE.home.subcommands.snapshot`) else `git -C ~/.mattstack add -A && commit -m "setup: snapshot" (allow empty → skip) && push` via p.exec; done/failed (remedy "check `git -C ~/.mattstack status`").
- `verify`: `composePlan({p, secrets: realSecretPresence(), ci: ctx.ci})` → `rowsToChecks` → any critical fail → failed detail "N checks failed: ids" remedy "Run `rt verify` for details"; else done "N checks passed".

- [ ] **Step 1: Failing tests.** plugins: argv sequence per config dir (`marketplace add` ×3, `install` ×3 for one config dir), "already installed" stderr tolerated, exit 1 → failed with the contract remedy text; fast-browser/herdr/extension skip paths; services.start: tray 200 + daemon ping ok → done; snapshot.push uses git fallback when no snapshot verb; verify: a fake plan with one required missing → failed.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0. **Step 5: Commit** `MAT-383: apply steps — plugins, fast-browser, herdr, extension, start, snapshot, verify`

---

### Task 27: `rt setup apply`, `rt setup` (TTY walk), `rt setup intent`, `--post-install` entry

**AFTER L4 T9 merges** (`bundleRootFromExec`, `legacyUserAppPath`; rebase onto `origin/main` first). `commands/post-install.ts` and `lib/__tests__/post-install-sweep.test.ts` are **L1-owned**: L4 T9 dropped them from its Files; their L4 bodies (`appPathIsTransient` refusal, `runLegacySweep(root)`, the new sweep test case, the `bundleRoot` override) are absorbed here verbatim, while `recordAppPath`/`installRtBinaryStep` are **not** re-implemented (they are the `settings.seed` / `path.link` steps).

**Files:**
- Modify: `commands/setup.ts` (`setupApply`, `setupInteractive` real, `setupIntent`), `commands/post-install.ts` (entry only: legacy sweep + transient-path refusal + `setupApply(["--non-interactive","--team-of-one",...args])`), `cli.ts` (`--post-install` passes remaining args), `lib/command-tree-def.ts` (`setup apply`, `setup intent` hidden)
- Test: `commands/__tests__/setup-apply.test.ts`, `lib/__tests__/post-install-sweep.test.ts` (existing; keep green — sweep functions are retained — plus the new stale-`~/Applications` case below)

**Interfaces:**
- Produces:

```ts
export async function setupApply(args: string[], _ctx?: CommandContext, deps = realApplyDeps()): Promise<void>
//  --json → NDJSON emitter; else human emitter; --from <stepId> (unknown id → exit 2 "bad-step"); --non-interactive; --team-of-one; --ci; --no-launch
//  --no-launch (implied by --ci or CI=true): never `open` the app or launch anything GUI — the clean-room runner (L7) and release.yml's headless job depend on this
//  exit code: done ok → 0; failed → 2 (the stream already carries the payload); bug → 1
export async function setupInteractive(args: string[], _ctx?: CommandContext, deps = realApplyDeps()): Promise<void>
//  TTY: print the plan (renderPlanHuman); if !canInstall → list requiredMissing with their action labels and exit 2 (code "not-ready") unless --force; else confirm (lib/rt-render confirm) "Install now?" → setupApply([]) ; non-TTY → behaves as `setup status`
export async function setupIntent(args: string[], _ctx?, deps?): Promise<void>   // hidden: rt setup intent restore <org>/<repo> | rt setup intent clear  → writes/clears intent; --json envelope
```
`commands/post-install.ts` (entry only; signature and bodies ported from L4 T9):

```ts
export interface PostInstallOptions { bundleRoot?: string | null }   // test override; production passes nothing
export async function runPostInstall(args: string[], opts: PostInstallOptions = {}): Promise<void>
//  root = opts.bundleRoot !== undefined ? opts.bundleRoot : bundleRootFromExec()   (lib/bundle-layout.ts)
//  1. runLegacySweep(root)  2. appPathIsTransient(root) → print "running from <root> — drag mattstack.app to /Applications and run this again" and process.exit(2)
//  3. setupApply(["--non-interactive","--team-of-one", ...args])   (no recordAppPath / installRtBinaryStep here — settings.seed and path.link are the steps)
function appPathIsTransient(root: string | null): boolean { return !!root && (root.startsWith("/Volumes/") || root.includes("/AppTranslocation/")); }
function runLegacySweep(root: string | null): boolean
//  runs on every post-install, idempotent, BEFORE anything launches or registers:
//  - unconditional `launchctl bootout gui/<uid>/com.rt.daemon` (ignore failures)
//  - legacyTrayAppPaths() that exist → osascript quit "rt-tray" (3 s timeout), `pkill -x rt-tray`, `rm -rf` each → swept
//  - stale = legacyUserAppPath() (~/Applications/mattstack.app): when root && root !== stale && exists(stale) → osascript quit <TRAY_APP_NAME>, `pkill -x <TRAY_APP_NAME>`, `launchctl bootout gui/<uid>/com.mattstack.daemon` (its BundleProgram points into the bundle being deleted; apply re-registers), `rm -rf stale` → swept
//  every spawnSync passes env: process.env; reportMigrationOutcome() runs when swept
```
`root === null` (e.g. `dist/rt` outside a bundle) takes the "not running from inside the app" branches: no sweep of `~/Applications`, no transient refusal, and `settings.seed`/`path.link` report honestly ("not running from inside the app"). `installRtBinaryStep/installTrayApp/installExtensions/installDaemon` bodies are deleted (replaced by steps); `repairShellWrapper` stays (moved into `path.link` as a log-only repair — call it there).

- [ ] **Step 1: Failing tests.** `setupApply(["--json"], {}, deps)` with a fake STEPS override emitting one stub step → stdout lines parse as `plan, step, step, done`; failed step → process exit seam called with 2; `--from bogus` → exit 2 `bad-step`; `setupInteractive` non-TTY prints the status table; `setupIntent(["restore","o/r"])` writes intent mode restore. `post-install-sweep.test.ts` gains L4's case (same fake-bin harness): stale `~/Applications/mattstack.app` under the test HOME + `runPostInstall([], { bundleRoot: "/Applications/mattstack.app" })` → the fake log shows `launchctl bootout … com.rt.daemon`, `rm -rf <stale>`, and `launchctl bootout … com.mattstack.daemon`; and `runPostInstall([], { bundleRoot: "/Volumes/mattstack/mattstack.app" })` → exit seam 2 with the drag-to-Applications message and no apply.
- [ ] **Step 2:** fail. **Step 3:** implement; `cli.ts`: `--post-install` → `runPostInstall(args.slice(1))`. **Step 4:** green; tsc 0. **Step 5: Commit** `MAT-383: rt setup apply + interactive walk; --post-install is headless apply`

---

### Task 28: `rt setup pack`

**Files:**
- Create: `lib/setup/pack.ts`
- Modify: `commands/setup.ts` (`setupPack`), `lib/command-tree-def.ts`
- Test: `lib/setup/__tests__/pack.test.ts`

**Interfaces:**
- Produces:

```ts
export async function setupPackFlow(ctx: ApplyContext): Promise<{ ok: boolean; stage?: string; detail: string }>
//  1. run the plugins.install step body (export it as installPlugins(ctx)) ; 2. materializeSkills ; 3. pipeline-resolves check: workType = reqs[0]?.workType ?? "feature";
//  manifest = first registered repo's ~/.mattstack/repos/<slug>/skills.jsonc (p.readFile); pipelines[workType].stages each must resolve to a binding (every stage name appears under bindings with a non-empty value) — missing → {ok:false, stage, detail:`stage "<s>" is unresolved`}
export async function setupPack(args, _ctx?, deps?): Promise<void>   // --json; unresolved → exit 2 code "stage-unresolved" with {stage}
```
- [ ] **Step 1: Failing tests.** manifest with all stages bound → ok; one stage unbound → `stage-unresolved` with the stage name; no manifest → detail "no per-repo manifest yet" ok:false code "no-manifest".
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0. **Step 5: Commit** `MAT-383: rt setup pack — plugins + bindings + pipeline-resolves check`

---

### Task 29: `rt uninstall`

**Files:**
- Create: `lib/setup/uninstall.ts`, `commands/uninstall.ts`
- Modify: `lib/command-tree-def.ts` (`uninstall` root node), `lib/module-registry.ts`
- Test: `lib/setup/__tests__/uninstall.test.ts`

**Interfaces:**
- Produces:

```ts
import type { UninstallActionId } from "../setup/contract.ts";   // defined in Task 1
export interface UninstallAction { id: UninstallActionId; title: string; kind: StepKind }
export function computeUninstallActions(p: Probes, opts: { keepData: boolean }): UninstallAction[]
//  always: services.unregister (app) "Stop and remove the rt daemon and deck services"; deck.managed-remove when deck resolves; proxy.remove (privileged) when /Library/LaunchDaemons/sh.portless.proxy.plist exists; path.unlink when any our-link exists; shell.remove when rc has the marker; extension.uninstall when setup-state.extensionEditors non-empty or detectEditors finds one; plugins.uninstall when setup-state has plugins/marketplaces; data (only when !keepData) "Delete ~/.mattstack (settings, teams, secrets)"; app.trash when appBundlePath resolves
export async function runUninstall(ctx: ApplyContext, actions: UninstallAction[]): Promise<{ ok: boolean; failed?: UninstallActionId; stayed: string[] }>
//  NDJSON via ctx.emit with the action ids as event ids (ApplyEvent.id is EventId = StepId | UninstallActionId); services.unregister → need {type:"app-unregister-services", plists}; deck: `deck remove --managed board`, `… gitq`; proxy.remove → need {type:"app-privileged", op:"proxy-remove"}; path.unlink → unlink each DEFAULT_EXPOSED + every our-link; shell.remove → removeShellIntegration()+removeZshenvPrecedence() (manual → stayed entry); extension.uninstall → `<cli> --uninstall-extension local.rt-context` per editor; plugins.uninstall → `claude plugin uninstall <p>` then `claude plugin marketplace remove <m>` per config dir (only what setup-state recorded); data → p.removeDir(~/.mattstack); app.trash → `osascript -e 'tell application "Finder" to delete POSIX file "<app>"'`; stayed: data when kept, anything manual
```
`commands/uninstall.ts`: `runUninstallCommand(args)` → `rt uninstall [--keep-data|--delete-data] [--dry-run] [--json] [--yes]`; dry-run prints `envelope({actions})`; real run on a TTY without `--yes` → confirm prompt listing actions; default keep-data. Confirmation rule: non-TTY + `--keep-data` (or no data flag) needs **no** `--yes`; `--delete-data` needs `--yes` — on non-TTY without it → exit 2 "confirm-required" (the app's Settings sheet is the confirmation, so the app always passes `--yes` with `--delete-data`).

- [ ] **Step 1: Failing tests.** actions list for a fully-installed fake state has all ids except `data` (keepData true); `--delete-data` adds `data`; `runUninstall` argv pins: `deck remove --managed board`, `claude plugin uninstall mattstack@mattstack`, `--uninstall-extension local.rt-context`, Finder osascript; need requests emitted for services/proxy; stayed includes "~/.mattstack (kept)".
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0; registry. **Step 5: Commit** `MAT-383: rt uninstall — reverses what the installer did, asks about ~/.mattstack`

---

### Task 30: `rt update` thin

Independent of other lanes: `commands/update.ts` is **L1-owned** (L4's competing rewrite, L4 T10, is dropped; exit codes follow the contract — `2` user-actionable with `--json`, not L4's `1`). L4 T12 regenerates `website/docs/reference/update.mdx` after this task lands.

**Files:**
- Modify: `commands/update.ts` (rewrite), `lib/command-tree-def.ts` (description "Check for updates via mattstack.app"; `--json` arg)
- Test: `commands/__tests__/update.test.ts`

**Interfaces:**
- Produces (deps shape adopted from L4 T10 so its test harness ports unchanged):

```ts
export const RELEASES_URL = "https://github.com/m4ttstack/rt/releases/latest";
export interface UpdateDeps {
  tray: (endpoint: string, method: "GET" | "POST") => Promise<{ ok: boolean; error?: string } | null>;   // trayRequest over tray.sock; null when the app is not running
  currentMode: () => "dev" | "prod";
  log: (line: string) => void;
  exit: (code: number) => never;
}
export async function runUpdate(args: string[], _ctx?: CommandContext, deps: UpdateDeps = realDeps): Promise<void>
```
Branches: dev mode → message unchanged ("dev mode is active — switch to prod first: rt settings dev-mode prod"), exit 2 (`--json` → `envelope({error:{code:"dev-mode"}})`), never calls the tray; `POST /update/check` → `{ok:true}` → "asked mattstack.app to check for updates (Sparkle) — watch the menu bar" exit 0 (`--json` → `envelope({asked:true})`); tray `null` (app not running) → "Updates come from mattstack.app (Sparkle). Open the app to check, or download the latest DMG: <RELEASES_URL>" and exit 2 with `--json` envelope `{error:{code:"app-not-running"}}`; `res.ok === false` (an older app that predates the route) → "this mattstack.app can't be asked from the CLI (<error>) — use the menu bar: mattstack → Check for Updates…" exit 2 (`--json` `{error:{code:"app-too-old"}}`). Delete `RELEASES_API`, `releaseAssetName`, the tarball download and the `--post-install` re-exec.
- [ ] **Step 1: Failing tests** for the four branches via the injectable `deps` (harness records `${method} ${endpoint}` calls, log lines, exit code; asserts `POST /update/check`, the releases URL in the not-running branch, "Check for Updates" in the `ok:false` branch, no tray call in dev mode, and exit 2 + `app-not-running` JSON with `--json`). **Step 2:** fail. **Step 3:** implement. **Step 4:** green; tsc 0. **Step 5: Commit** `MAT-383: rt update asks the app`

---

### Task 31: Human TTY polish + `dev-mode` TTY relaxation + reference regeneration

**AFTER L4 T12 merges** (`README.md` and `website/docs/getting-started/install.mdx` are L4's; L1 does **not** edit README). Rebase onto `origin/main` first; whoever merges second re-runs `docs:gen`/`docs:check`.

**Files:**
- Modify: `commands/setup.ts` (`renderPlanHuman` uses tui colors; `rt setup status` footer names `rt setup <integration> connect` for missing accounts), `lib/command-tree-def.ts` (`settings dev-mode`: drop `requiresTTY` when the `<dev|prod>` Target arg is given — the app's Settings pane runs `rt settings dev-mode dev|prod` non-interactively; prompt only when Target is omitted), regenerate docs: `bun scripts/gen-docs.ts`, `bun scripts/check-docs.ts`
- Test: `commands/__tests__/settings-dev-mode.test.ts` (non-TTY + explicit Target → no prompt, switches; non-TTY + no Target → exit 2 "target-required")
- [ ] Run `bun run docs:gen` → reference pages for every new verb exist (incl. `team status`, `update`); `bun run docs:check` clean; **assert** (do not edit) that L4 T12 already removed `tmux|zellij|terminal-notifier|brew install fzf` from README/website docs: `grep -rn 'tmux\|zellij\|terminal-notifier\|brew install fzf' README.md website/docs` → no hits (a hit means L4 T12 has not merged — stop and rebase, don't patch README here).
- [ ] Commit `MAT-383: docs + reference pages for the setup verbs`

---

### Task 32: e2e + full gates

**Files:**
- Create: `e2e/tests/setup.test.ts` (spawns `dist/rt` with an isolated HOME, `RT_SKIP_SETUP=1`, `CI=true`, `RT_APP_SOCKET=/nonexistent.sock`): `rt setup plan --json` exits 0, one JSON line, `contract===1`, groups ids in order, `perm.fda` status `error` (no app) with the `run` action; `rt setup apply --json --non-interactive --team-of-one --from verify` streams `plan` then `step verify …` then `done`; `rt deps resolve fzf --json` parses; `rt team join` with a code on argv exits 2 with `code-on-argv`; `rt uninstall --dry-run --json` lists actions; `rt update --json` exits 2 `app-not-running`.
- [ ] `rm -f dist/rt && bun run build` (whatever `scripts`/README says builds `dist/rt` — check `package.json`/README for the compile command; typically `bun build --compile cli.ts --outfile dist/rt`) then `bun run test:all` green; `bun x tsc --noEmit` 0.
- [ ] Rebase onto `origin/main` (settings lane landed overnight): resolve, rerun all gates.
- [ ] Commit `MAT-383: e2e — setup verbs end to end from the compiled binary`

---

### Task 33 (ORCHESTRATOR-ONLY, live machine): smoke against the real tray + keychain

Not a subagent task. From the worktree with the real HOME:
1. `bun run cli.ts setup plan --json | jq .` — rows render; `perm.*` come from the live app once L3 serves `GET /permissions` (until then they report `error` with the re-check action — expected and honest).
2. `bun run cli.ts verify` — same verdicts as before the refactor for daemon/app/fzf/extension/shell/intercepts (compare against a pre-branch `rt verify` run saved in the scratchpad).
3. `bun run cli.ts deps resolve fzf --json`; `… deps link gh` (expect `user-copy` refusal on Matt's machine — brew gh exists).
4. `bun run cli.ts team create demo-team --remote <empty throwaway repo URL> --json` on a throwaway GitHub repo, then `team invite --handle <matt's handle>`, then from a second HOME (`HOME=/tmp/h2 bun run cli.ts team join --dry-run` with the code on stdin) — expect `access:"ok"` once L6's relay is deployed; until then `relay-unreachable` exit 2 is the expected honest result. Delete the throwaway team dir afterwards.
5. Merge checkpoint: rebase onto `origin/main`, gates green, open the PR (Matt's checkpoint).

---

## Execution order note

Tasks are numbered for reading; execute in this order to honor in-lane dependencies: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → **13 (team secrets) before 12** → 12 → 14 → 15 → 16 → 17 → 18 → 19 → 20 → 21 → 22 → 23 → 24 → 25 → 26 → 27 → 28 → 29 → 30 → 31 → 32 → 33.

Cross-lane gates (binding; see the "Execution order (cross-plan)" paragraph at the top and `2026-08-21-cross-plan-review.md` §3): Phase A = 1–4, 6, 9, 13–19 can start immediately off `origin/main`; **Task 5 waits for L4 T1 + T9**; **Tasks 7, 8, 10, 11, 21 wait for Task 5 and L4 T11**; **Tasks 24, 27 wait for L4 T9**; **Task 31 waits for L4 T12**; Tasks 22, 23, 25, 26, 28–30, 32 have no external gate. Rebase onto `origin/main` before every merge. In practice this means Phase A first (T1–T4, T6, T9, T13–T19 — T13 before T12 still holds, so T12 joins the second wave), then the rest in numeric order once the L4 gates have merged.

## Self-review

**Spec coverage (§ → task):** §4.3 rows: mac (6, 8), accounts incl. owner-once Slack + switchboard + team-declared connects (9, 12), access (9), tools incl. herdr/claude/fast-browser/editor/Chrome/Control+Up/team tools/MCP-inside-pack (8); permission merge via GET /permissions (6); §4.4 every listed install step (24–26) in the contract's order (23); failed-step remedy + `--from` resume (23, 27); §4.2 create/join/restore inputs (16, 18, 27 intent), join failure strings (18), `--dry-run` with code on stdin (18); §5.2 verb table: setup plan/status/connect/slack create-app/pack/apply/TTY (10, 12, 27, 28), team create/join/invite/members/publish/status (16–19), repos register (20), skills materialize (20), cron install (20), tools setup (21), deps resolve/link/unlink (5), services (22), update (30), uninstall (29), verify (11); §5.3 routes consumed: /permissions (6), /services* (22), /setup/need (22), /update/check (30); §6 invite model (14, 15, 17, 18), replace-on-mint, 7-day expiry, roster, reply key exchange (17–19); §7 four-way policy: bundled by absolute path + default-exposed links + auto-unlink reconcile on verify/daemon start (5, 7), provision via brew/vendor (21), CLT (6, 21), team-declared (4, 8, 21); §9 rows + honest fallback (6); §10 team-scope secrets N recipients + rotate --team + residue note (13, 19); §11 `--post-install` → headless apply (27), `rt update` thin (30); §12.3 uninstall list (29); §13 L1 contents all present; contract envelope/exit codes/step ids/NDJSON/stdin-only secrets (1, 2, 27). **Gaps:** `rt restore` itself, `rt home snapshot push`, board/gitq/deck binaries, the relay endpoints, the app's routes — all other lanes; L1 consumes them behind honest guards (24, 26).

**Placeholder scan:** no TBD/TODO; every step has code or exact argv/assertions; the Task 23 stubs are explicitly replaced by 24–26 (the `STEPS` id test enforces completeness); "similar to" is not used — each step body is spelled out.

**Type consistency:** `Row/Plan/Action/ApplyEvent/StepId/NeedRequest` defined once in Task 1 and used by name in 6–11, 22–29; `Probes`/`TrayClient` from Task 2 everywhere; `SetupIntent/InvitePointer` (3) used by 9, 16, 18, 24, 27; `TeamSnapshot` (9) used by 17, 23, 25; `RelayClient` (15) by 17–19, 23; `SecretsSeams` is the existing store type; `resolveTool/link/reconcile` (5) by 7, 8, 21, 24, 25, 29; `StepOutcome/ApplyContext/STEPS` (23) by 24–29; `rowsToChecks` (11) by 26; `servicePlists` (22) by 25, 29; `setupTool/installTool` (21) by 26; `materializeSkills/installCronTrigger` (20) by 25, 28.

## Open questions (spec gaps found while planning)

1. **`need` reply direction — RESOLVED** (cross-plan review, L3 T9 + contract): rt polls `GET /setup/need/<id>` on tray.sock; the app always answers 200 `{state: pending|done|failed, detail}` (unknown ids are `pending`, `POST` → 405); rt keeps polling until `done|failed` and tolerates a 404 as pending. Task 22 implements exactly this.
2. **Invite code length — RULED (R5): stays 77 chars.** 16-byte id + 32-byte key = 77 base32 chars (chunked); L6 returns 16-byte ids (32 hex). The spec's "~40 chars" wording is amended to 77 in the appspec branch.
3. **Relay base URL.** Not in the spec; pinned `https://switchboard.mattstack.dev` with `RT_INVITE_RELAY_URL` override. L6 to confirm (and whether `GET /v1/invites/:id/reply` + a creator-secret Bearer is the agreed owner read path — the spec only names the reply POST).
4. **Join-intent persistence.** The decrypted pointer + invite key live in `~/.mattstack/rt/setup-intent.json` (0600, runtime) between screen 2 and Install. Alternative: the app re-supplies `{"code"}` on apply's stdin. The plan uses the file; confirm.
5. **Restore card protocol — RULED (R3):** the app (L3 T13) runs the real `rt restore <org>/<repo>` (age key on stdin `{"ageKey"}`) when the user presses Continue on the restore card, then `rt setup intent restore <org>/<repo>`; L1's `home.restore` step only verifies (Task 24). Still open with the settings lane: the exact `rt restore --json` / stdin-key flags once R lands, and whether it materializes plugins itself (then `plugins.install` is idempotent anyway).
6. **Home remote without gh.** `rt home init` is gh-only today; the wizard's "paste a URL" path for the home repo needs a `--remote <url>` on `rt home init` (settings lane) — L1 passes it through when it exists.
7. **`board.members` entry shape** (`{username}` + `agePublicKey` added by members sync) and `board.triage.enabled` as the triage-cron gate — board lane to confirm key shapes; guarded by `getDef` so nothing breaks if they differ.
8. **`deck add` argv for managed apps** (`--managed-by mattstack --host board.mattstack`) is MAT-384's; pinned in one call site + one test.
9. **First-run auto-setup** in `cli.ts` no longer auto-runs a full install (it would create GitHub repos silently); it now prints a one-line hint. Accepted by the cross-plan review (§4 #7): L4 T12's README "Testing the installer" describes `rt --post-install` as the headless `rt setup apply --non-interactive --team-of-one` and does not promise auto-setup on first `rt` run.
10. **Multi-team machines:** `rt setup plan` takes the first cloned team alphabetically unless `--team`; the picker is deferred (spec §14).
11. **Headless `--team-of-one` defaults:** team name `personal`, gh-created `<login>/mattstack-team-personal` unless `RT_TEAM_NAME`/`RT_TEAM_REMOTE` are set. The clean-room runner has no gh auth and sets neither env var, so `team.create` is **skipped** with detail (Task 24) rather than failed — the headless job reaches `verify`.
12. **Team-scope secrets file layout** (`teams/<slug>/.sops.yaml` + `teams/<slug>/mattstack/secrets/<domain>.json`) must be acknowledged by the settings lane before Task 13 merges (spec §14 coordination note).
13. **Mattstack marketplace source.** The MAT-360 meta repo URL is not final; pinned as `https://github.com/m4ttstack/mattstack-marketplace` behind `RT_MATTSTACK_MARKETPLACE`. L5 to confirm, and to confirm `claude plugin marketplace add <git-url>` is the supported form (today's marketplace is a local directory).
14. **`claude plugin list` / `claude auth status` output shapes** are probed defensively (unknown subcommand → "not checked", honest detail); if Claude Code exposes `--json` for these, tighten the parsers in Task 8.
