# rt chat delivery v2 (socket-first) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver chat message bodies straight into each Claude recipient's per-session inbox socket from the rt daemon, and hard-cut the doorbell machinery (tail/Monitor/pulse/deaf) out in the same release.

**Architecture:** A new `lib/claude-registry.ts` resolves a Claude session uuid to its inbox socket by scanning the on-disk session registries; a new `lib/daemon/inbox.ts` writes one JSON frame per delivery. `postAndNotify` delivers bodies instead of emitting `chat/wake/*`. Sign-in gains a daemon-side `--pane` mode driven by herdr-chat, a welcome frame teaches the reply contract once, and `rt agent` reserves the handle and passes `--name`. Presence reduces to socket reachability plus the registry's busy/idle mirror.

**Tech Stack:** Bun + TypeScript (repo-tools), bun:test with fake filesystem dirs and a real in-test Unix socket server, Rust (herdr-chat plugin), shell (marketplace chat plugin hooks).

**Spec:** `docs/superpowers/specs/2026-08-28-rt-chat-delivery-v2-design.md` (ratified; decisions table inside is binding).

## Global Constraints

- HARD CUTOVER: doorbell deletions land in this plan, not a follow-up; no dual delivery period.
- Deliver immediately, always; existing `wake_on` recipient rules (`lib/state/chat-store.ts:434-446`) are unchanged.
- Delivered frame content is plain text (`[#room] handle: body`); never emit a `<cross-session-message>` envelope; never read or reference `CLAUDE_CODE_MESSAGING_TOKEN`.
- Frame shape, exactly: `{"msgV":1,"msg_id":"<uuid>","type":"user","message":{"role":"user","content":"<text>"},"priority":"next"}` followed by `\n`, one frame per connection.
- Registry dirs to scan: `~/.claude/sessions` and every `~/.claude-swap-backup/sessions/*/sessions` (glob the account level, tolerate absence).
- No em dashes or en dashes in any prose, comment, or commit message.
- Comments only for constraints code cannot show (clean-code rule); decision history goes in reports, not source.
- Tests: `bun test` in repo-tools; `cargo test --release` in herdr-chat; each task commits on green.
- Repos: Tasks 1-5, 7, 9 in the repo-tools worktree (`~/Documents/GitHub/repo-tools-chat-delivery-v2`, branch `chat-delivery-v2`). Task 6 in a herdr-chat worktree; Task 8 in a mattstack-marketplace worktree (create with `git worktree add` from each repo's main).

---

### Task 1: Claude session registry resolver

**Files:**
- Create: `lib/claude-registry.ts`
- Test: `lib/__tests__/claude-registry.test.ts`

**Interfaces:**
- Produces: `resolveInbox(sessionId: string, opts?: { roots?: string[] }): InboxBinding | null` and `type InboxBinding = { pid: number; socketPath: string; status: "busy" | "idle" | "shell" | undefined; name?: string }`. `roots` defaults to the real registry dirs; tests pass fake dirs.
- Produces: `inboxAlive(b: InboxBinding): boolean` (pid alive via `process.kill(pid, 0)` in try/catch AND socket file exists).

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveInbox } from "../claude-registry.ts";

function fakeRoot(entries: Array<{ pid: number; sessionId: string; sock?: string; status?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), "creg-"));
  for (const e of entries) {
    writeFileSync(
      join(root, `${e.pid}.json`),
      JSON.stringify({ pid: e.pid, sessionId: e.sessionId, messagingSocketPath: e.sock ?? `/tmp/cc-socks/${e.pid}.sock`, status: e.status ?? "idle" }),
    );
  }
  return root;
}

describe("resolveInbox", () => {
  test("finds a session by uuid in the first root", () => {
    const root = fakeRoot([{ pid: 111, sessionId: "aaaaaaaa-0000-0000-0000-000000000001" }]);
    const hit = resolveInbox("aaaaaaaa-0000-0000-0000-000000000001", { roots: [root] });
    expect(hit).toEqual({ pid: 111, socketPath: "/tmp/cc-socks/111.sock", status: "idle", name: undefined });
  });
  test("scans later roots (cswap accounts) when the first misses", () => {
    const a = fakeRoot([]);
    const b = fakeRoot([{ pid: 222, sessionId: "bbbbbbbb-0000-0000-0000-000000000002", status: "busy" }]);
    expect(resolveInbox("bbbbbbbb-0000-0000-0000-000000000002", { roots: [a, b] })?.pid).toBe(222);
  });
  test("returns null for unknown uuid, missing dir, malformed json, and entry without messagingSocketPath", () => {
    const root = fakeRoot([{ pid: 333, sessionId: "cccccccc-0000-0000-0000-000000000003" }]);
    writeFileSync(join(root, "334.json"), "{not json");
    writeFileSync(join(root, "335.json"), JSON.stringify({ pid: 335, sessionId: "dddddddd-0000-0000-0000-000000000004" }));
    expect(resolveInbox("eeeeeeee-0000-0000-0000-000000000005", { roots: [root] })).toBeNull();
    expect(resolveInbox("cccccccc-0000-0000-0000-000000000003", { roots: [join(root, "missing")] })).toBeNull();
    expect(resolveInbox("dddddddd-0000-0000-0000-000000000004", { roots: [root] })).toBeNull();
  });
});
```

- [ ] **Step 2: Run and verify failure**: `bun test lib/__tests__/claude-registry.test.ts` fails with "Cannot find module".

- [ ] **Step 3: Implement `lib/claude-registry.ts`**

```ts
/**
 * Read-only view of Claude Code's on-disk session registries. The uuid in
 * chat presence rows IS Claude's session id (rt chat sign-in keys on
 * CLAUDE_CODE_SESSION_ID; daemon-side sign-in reads herdr's agent_session),
 * so a registry hit is the whole pane-to-inbox resolution.
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface InboxBinding {
  pid: number;
  socketPath: string;
  status: "busy" | "idle" | "shell" | undefined;
  name?: string;
}

export function registryRoots(): string[] {
  const home = homedir();
  const roots = [join(home, ".claude", "sessions")];
  const swap = join(home, ".claude-swap-backup", "sessions");
  try {
    for (const account of readdirSync(swap)) roots.push(join(swap, account, "sessions"));
  } catch { /* no cswap accounts */ }
  return roots;
}

const STATUSES = new Set(["busy", "idle", "shell"]);

export function resolveInbox(sessionId: string, opts?: { roots?: string[] }): InboxBinding | null {
  for (const root of opts?.roots ?? registryRoots()) {
    let files: string[];
    try { files = readdirSync(root); } catch { continue; }
    for (const f of files) {
      if (!/^\d+\.json$/.test(f)) continue;
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(readFileSync(join(root, f), "utf8")); } catch { continue; }
      if (entry.sessionId !== sessionId) continue;
      if (typeof entry.pid !== "number" || typeof entry.messagingSocketPath !== "string") continue;
      const status = typeof entry.status === "string" && STATUSES.has(entry.status) ? (entry.status as InboxBinding["status"]) : undefined;
      return { pid: entry.pid, socketPath: entry.messagingSocketPath, status, name: typeof entry.name === "string" ? entry.name : undefined };
    }
  }
  return null;
}

export function inboxAlive(b: InboxBinding): boolean {
  try { process.kill(b.pid, 0); } catch { return false; }
  return existsSync(b.socketPath);
}
```

- [ ] **Step 4: Run tests, expect pass.**
- [ ] **Step 5: Commit** `chat: claude session registry resolver (lib/claude-registry.ts)`

---

### Task 2: Inbox frame sender

**Files:**
- Create: `lib/daemon/inbox.ts`
- Test: `lib/daemon/__tests__/inbox.test.ts`

**Interfaces:**
- Consumes: `InboxBinding` from Task 1.
- Produces: `deliverToInbox(socketPath: string, content: string, opts?: { timeoutMs?: number }): Promise<{ ok: true } | { ok: false; error: string }>` and `renderDeliveries(items: Array<{ room: string; dm: boolean; handle: string; body: string }>): string` (one `[#room] handle: body` or `[dm] handle: body` line per item, joined with `\n`).

- [ ] **Step 1: Write failing tests.** Use a real Unix socket server in the test (Bun.listen on a tmpdir path) that records received lines:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { deliverToInbox, renderDeliveries } from "../inbox.ts";

test("renderDeliveries formats room and dm lines", () => {
  expect(renderDeliveries([
    { room: "general", dm: false, handle: "max", body: "hello" },
    { room: "dm-1", dm: true, handle: "eli", body: "hi" },
  ])).toBe("[#general] max: hello\n[dm] eli: hi");
});

test("deliverToInbox writes exactly one msgV:1 user frame line", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "inbox-")), "s.sock");
  const lines: string[] = [];
  const server = Bun.listen({ unix: path, socket: { data(_s, d) { lines.push(d.toString()); } } });
  const res = await deliverToInbox(path, "[#general] max: hello");
  await Bun.sleep(30);
  server.stop(true);
  expect(res.ok).toBe(true);
  const frame = JSON.parse(lines.join("").trim());
  expect(frame.msgV).toBe(1);
  expect(frame.type).toBe("user");
  expect(frame.priority).toBe("next");
  expect(frame.message).toEqual({ role: "user", content: "[#general] max: hello" });
  expect(typeof frame.msg_id).toBe("string");
});

test("deliverToInbox reports failure on a dead socket", async () => {
  const res = await deliverToInbox(join(tmpdir(), "nope.sock"), "x", { timeoutMs: 200 });
  expect(res.ok).toBe(false);
});
```

- [ ] **Step 2: Run, verify failure.**
- [ ] **Step 3: Implement `lib/daemon/inbox.ts`** with `Bun.connect({ unix })`, write `JSON.stringify(frame) + "\n"`, `end()` after the write flushes, resolve `{ok:true}`; wrap connect errors and a `timeoutMs` (default 1000) race into `{ok:false,error}`. `msg_id` via `crypto.randomUUID()`.
- [ ] **Step 4: Run tests, expect pass.**
- [ ] **Step 5: Commit** `chat: inbox frame sender (lib/daemon/inbox.ts)`

---

### Task 3: Daemon delivery replaces the wake emit

**Files:**
- Modify: `lib/daemon/handlers/chat.ts` (`postAndNotify`, lines 89-121)
- Modify: `lib/state/chat-store.ts` (export a `markDelivered(room, handle, upToId, db)` that advances `last_read_id` like markRead does; reuse the existing markRead internals)
- Test: `lib/daemon/__tests__/chat-delivery.test.ts`

**Interfaces:**
- Consumes: `resolveInbox`/`inboxAlive` (Task 1), `deliverToInbox`/`renderDeliveries` (Task 2), `presenceForHandle` (presence-store).
- Produces: `postAndNotify` keeps its signature and return; delivery seam `type InboxDeps = { resolve: typeof resolveInbox; deliver: typeof deliverToInbox }` threaded with defaults so tests inject fakes.

- [ ] **Step 1: Write failing tests** (fake deps): posting to a room with a signed-in recipient (presence row seeded with a sessionId the fake resolver knows) calls the fake deliver with `[#general] author: body` and advances the recipient's cursor; a recipient whose resolver misses gets no deliver call and keeps unread; `wake_on: "none"` members are never delivered; DM posts render `[dm]`; the human desk-notification path still fires on mention (existing assertion style in `lib/daemon/__tests__/` chat tests).
- [ ] **Step 2: Run, verify failure.**
- [ ] **Step 3: Implement.** In `postAndNotify`: keep `postMessage` + `emitEvent("chat/<room>/msg")` (the viewer needs it). Replace the `chat/wake/<recipient>` loop with: for each recipient, `presenceForHandle` -> `resolveInbox(row.sessionId)` -> if alive, `deliverToInbox(sock, renderDeliveries([...pending for that recipient...]))`; on `ok`, `markDelivered` up to the posted id; on failure, leave unread (the badge task surfaces it). Delivery is fire-and-forget from the post's perspective: run it via `queueMicrotask`/`void` so `chat:post` latency stays one store write, but thread the promise back in tests via the seam.
- [ ] **Step 4: Run the chat handler test file and the full chat suites, expect green.**
- [ ] **Step 5: Commit** `chat: deliver message bodies to Claude inbox sockets from postAndNotify`

---

### Task 4: Sign-in v2 (daemon-side --pane, welcome frame, no rename)

**Files:**
- Modify: `packages/rt-client/src/commands.ts` (`chat:sign-in` payload gains `pane?: string` ALREADY present; add `viaPane?: boolean`; data unchanged)
- Modify: `lib/daemon/handlers/chat.ts` (sign-in handler: when `viaPane`, resolve the pane's Claude session via herdr, then run the normal sign-in; afterwards send the welcome frame)
- Modify: `commands/chat.ts` (`runSignIn`: support `--pane <id>` with no CLAUDE_CODE_SESSION_ID; drop the rename block at lines 971-977 and the "arm your tail" line at 986)
- Delete: `lib/chat-rename.ts` and its tests
- Test: extend the daemon chat handler tests + `commands/__tests__/chat.test.ts`

**Interfaces:**
- Consumes: `herdrRequest` (already imported in handlers/chat.ts) with `session.snapshot` to read `panes[].agent_session.value` for the pane; Tasks 1-2 for the welcome delivery.
- Produces: welcome content builder `renderWelcome(handle: string, rooms: string[], catchup: Array<{room: string; lines: string[]}>): string` exported for tests; the string must include the handle, the room list, the sentence `Messages will arrive in your context automatically; you never need to poll or arm anything.`, the reply contract line `Reply with: rt chat post <#room|@handle> "..."`, and at most 10 catch-up lines per room.

- [ ] **Step 1: Write failing tests**: `viaPane` sign-in with a fake herdr runner mapping pane `w1:p1` to a uuid produces a presence row keyed by that uuid and one welcome delivery whose content contains the handle and the contract line; baseHandle defaults to the registry entry's `name` when present (fake resolver returns `name: "kai"`); CLI `runSignIn` with `--pane` skips git derivation (cwd/repo/branch come from the herdr pane row via `rt pane list` fields already in the daemon) and prints the handle; no rename subprocess is planned (assert `planSessionRename` is gone by module absence).
- [ ] **Step 2: Run, verify failure.**
- [ ] **Step 3: Implement**, keeping the handle draw, suffixing, and room-derivation logic exactly where they are. Welcome delivery goes through the same Task 3 seam. Delete `lib/chat-rename.ts`, its import and the rename block in `commands/chat.ts`, and `readSessionCustomTitle`/`composeSessionTitle` call sites if now unused (keep `chat-title.ts` only if another caller remains; delete it too when orphaned).
- [ ] **Step 4: Run chat suites, expect green.**
- [ ] **Step 5: Commit** `chat: daemon-side sign-in --pane with welcome frame; delete session rename`

---

### Task 5: rt agent reserves the handle and passes --name and inbound settings

**Files:**
- Modify: `lib/agent-argv.ts` (`ClaudeInvocation` gains `name?: string`; `claudeArgs` pushes `--name <name>` and `--settings '{"crossSessionInbound":"accept"}'` for interactive starts)
- Modify: `lib/daemon/handlers/agent.ts` (`agent:start`: draw the name via the existing chat-names pool against live presence BEFORE building the invocation; store it on the AgentRecord as `handle`)
- Modify: `commands/agent.ts` (print the reserved handle in the start output)
- Test: `lib/__tests__/agent-argv.test.ts`, `lib/daemon/__tests__/agent-handlers.test.ts` (extend existing)

**Interfaces:**
- Consumes: `pickAgentName` from `lib/chat-names.ts` (same draw sign-in uses; pass the set of handles currently held by live presence rows so the reservation and a later sign-in agree).
- Produces: `AgentRecord.handle?: string`; argv contains `--name`, `--settings` before the prompt token.

- [ ] **Step 1: Write failing argv tests**: `buildClaudeArgv({... name: "kai" ...})` includes `["--name", "kai", "--settings", '{"crossSessionInbound":"accept"}']`; headless invocations include neither flag; `buildPaneCommand` single-quotes both.
- [ ] **Step 2: Run, verify failure.**
- [ ] **Step 3: Implement**; sign-in (Task 4) already prefers the registry `name` as baseHandle, which closes the loop: reserved name -> --name -> registry -> sign-in adopts it.
- [ ] **Step 4: Run agent suites, expect green.**
- [ ] **Step 5: Commit** `agent: reserve chat handle at start; pass --name and inbound accept settings`

---

### Task 6: herdr-chat plugin calls daemon-side sign-in (separate repo)

**Files (in a herdr-chat worktree off main):**
- Modify: `src/cmd/sign.rs` (replace `rt::pane_send(runner, pane, "/chat:sign-in", true)` with running `rt chat sign-in --pane <pane> --json`; same for sign-out)
- Modify: `src/cmd/detect.rs:74` (Always path: same replacement)
- Modify: `src/cmd/signin_ask.rs` (confirm path routes through the same call)
- Modify: `src/rt.rs` (add `chat_sign_in_pane(runner, pane) -> Result<String, String>` running `["rt", "chat", "sign-in", "--pane", pane, "--json"]`, scrubbed env like pane_send)
- Test: existing `cargo test` fakes assert the new argv

- [ ] **Step 1: Write failing Rust tests** asserting the exact argv `rt chat sign-in --pane w1:p1 --json` (env: `HERDR_PANE_ID` unset) replaces the old pane_send argv in sign, detect-Always, and signin-ask confirm paths.
- [ ] **Step 2: `cargo test --release`, verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `cargo test --release`, expect green.**
- [ ] **Step 5: Commit** `sign-in goes daemon-side: rt chat sign-in --pane, no pane injection`

---

### Task 7: Hard cutover deletions (repo-tools)

**Files:**
- Modify: `commands/chat.ts` (delete `chatTail`, `wakeLine`, `killChatTail`, `claimTailPidfile`, `readTailPid`, `isLiveChatTail`, `chatTailPidPath`, `testMarkerPause`, `TAIL_ROUND_MS`, the `tail` verb from `VERBS` and `USAGE`; `runSignOut` loses the killChatTail call)
- Modify: `lib/daemon/handlers/chat.ts` (delete `chat:arm`, `chat:touch`, `chat:disarm`, `chat:unread-waking`, `chat:pulse` handlers and their entries in `CHAT_COMMANDS`)
- Modify: `packages/rt-client/src/commands.ts` + `packages/rt-client/src/client.ts` (delete the five verbs' types and wrappers)
- Modify: `lib/state/chat-store.ts` (delete `armMember`, `touchMember`, `disarmMember`, `unreadWakingCount` if now unused by the viewer path, `clearAllArmed`; keep `readUnread`/`markRead`)
- Modify: `lib/state/presence-store.ts` (drop `tailSeenAt`/`armedAt` columns from types, SQL, and `buddyStatus`; `BuddyStatus` narrows to `"live" | "idle" | "offline"`; new rule: `offline` when signed out or pruned; else `live` when the registry binding is alive with status busy, `idle` otherwise; `RECLAIMABLE_SQL` loses its tail leg: reclaimable when signed out OR session-stale AND the registry binding is dead, computed in TS around the query)
- Modify: `lib/daemon.ts:456-464` (drop `clearAllArmed`; keep `prunePresence`)
- Modify: `lib/daemon/handlers/pane.ts` and `chat:buddies` (status now computed with a registry probe: thread `resolveInbox`/`inboxAlive` with fakeable deps)
- Test: update every touched suite; delete tail tests
- Note: sqlite columns stay in place physically (no migration); code stops reading and writing them. Record this in the task report.

- [ ] **Step 1: Delete tail-side code and update tests to failure-red on the new presence rule.**
- [ ] **Step 2: Implement the reduced `buddyStatus` and registry-probe wiring.**
- [ ] **Step 3: Run the FULL repo-tools test suite; fix every reference the deletions broke (grep for `chatArm|chatTouch|chatDisarm|chatUnreadWaking|chatPulse|chat tail|armedAt|tailSeenAt|deaf`).**
- [ ] **Step 4: Commit** `chat: hard cutover, delete tail/arm/pulse/deaf machinery`

---

### Task 8: Marketplace chat plugin catches up (separate repo)

**Files (in a mattstack-marketplace worktree off main):**
- Delete: `plugins/chat/hooks/pulse.sh`, its `UserPromptSubmit` entry in `plugins/chat/hooks/hooks.json`, `plugins/chat/hooks/tests/test-pulse.sh`
- Modify: `plugins/chat/hooks/session-start.sh` (message becomes: signed in as `<handle>`; messages arrive automatically; no Monitor mention)
- Modify: `plugins/chat/skills/sign-in/SKILL.md` (two steps become one: run `rt chat sign-in`; no arm step; note messages arrive in context)
- Modify: `plugins/chat/skills/sign-out/SKILL.md` (drop the TaskStop step)
- Keep: `session-end.sh` sign-out hook unchanged.

- [ ] **Step 1: Make the edits; run `plugins/chat/hooks/tests/` scripts that remain.**
- [ ] **Step 2: Commit** `chat plugin: no pulse, no Monitor arm; delivery is push`

---

### Task 9: Skill docs, badge, and e2e (repo-tools)

**Files:**
- Modify: `skills/rt-chat/SKILL.md` (delete the gate's arming rationale, the whole "Sign in, then arm the tail" Monitor block, "Do not re-arm after reading"; add a short "How messages reach you" section: bodies arrive in context automatically as `[#room] handle: body`; reply with `rt chat post`; `rt chat read` is history/catch-up only)
- Modify: `lib/daemon/handlers/chat.ts` delivery-failure path (Task 3 seam): on failure, best-effort `herdrRequest("pane.report_metadata", { pane_id, source: "rt-chat", tokens: { chat_unread: String(n) }, ttl_ms: 600000, seq: Date.now() })` for the recipient's pane; swallow errors
- Create: `e2e/chat-inbox-delivery.test.ts` tagged like existing e2e (opt-in env `RT_E2E=1`): spawn `rt agent start` in a temp repo, daemon-side sign-in via `--pane`, `rt chat post` to its room, poll the session transcript jsonl for the body, then kill the pid and close the pane
- Modify: superseded spec sections: prepend a one-line pointer note to `docs/superpowers/specs/2026-08-23-rt-chat-design.md` and `2026-08-24-rt-chat-presence-design.md` naming this spec.

- [ ] **Step 1: Write the badge unit test (fake herdr runner records the report_metadata call on delivery failure).**
- [ ] **Step 2: Implement badge + docs + spec pointers; write the e2e.**
- [ ] **Step 3: Full `bun test`; run the e2e once locally with `RT_E2E=1`.**
- [ ] **Step 4: Commit** `chat: push-delivery docs, unread badge on failed delivery, inbox e2e`

---

## Self-review notes

- Type consistency: `InboxBinding`, `deliverToInbox`, `renderDeliveries`, `markDelivered`, `viaPane`, `AgentRecord.handle` are each defined in exactly one task and consumed by later ones as named.
- Task 3 lands delivery while Task 7 deletes the doorbell; both are in this plan and ship on one branch, satisfying the hard-cutover constraint (the branch merges as one PR).
- Viewer impact: `chat:buddies` keeps its shape; `BuddyStatus` loses `deaf`, which the viewer renders per-value and tolerates by absence. Note it in the final PR body for the chat repo.
