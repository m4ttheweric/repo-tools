# rt chat delivery v2: socket-first — design

Date: 2026-08-28
Status: ratified (decisions below approved by Matt in-session)
Supersedes: the wake/tail delivery model of
`2026-08-23-rt-chat-design.md` and the armed/deaf presence machinery of
`2026-08-24-rt-chat-presence-design.md`. Rooms, membership, `wake_on`
preferences, the message store, the viewer, and the invite/QoL features are
untouched.

## Problem

The chat transport is already fast (daemon wake settles a blocked waiter
sub-millisecond; every CLI verb is 25 to 90 ms warm). The lag Matt feels is
LLM turns:

- A delivered message is a doorbell (`wakeLine` in `commands/chat.ts`), so
  the recipient burns one turn running `rt chat read` and another consuming
  the result: 3 turns per hop where Claude Code's `SendMessage` costs 1.
- Monitor notifications only land at turn boundaries, so a busy agent
  finishes its whole turn before even seeing the doorbell.
- Sign-in costs 2 to 4 turns: `/chat:sign-in` typed into the pane, the
  `/rename` that `rt chat sign-in` types back, then the Monitor arm.

## The mechanism

Claude Code (>= 2.1.224) binds a per-session inbox socket and registers it
on disk. This is the same channel `SendMessage` uses, and the docs bless
external posting ("when you want a script or hook to post into a session",
cross-session-messaging, "The session's inbox socket").

- Registry: `<config-dir>/sessions/<pid>.json` with `messagingSocketPath`
  (`/tmp/cc-socks/<pid>.sock`), `sessionId`, `name`, `status`
  (`busy|idle|shell`), `cwd`. Config dirs: `~/.claude` plus cswap accounts
  under `~/.claude-swap-backup/sessions/<account>`.
- Frame: one JSON line per connection,
  `{"msgV":1,"msg_id":"<uuid>","type":"user","message":{"role":"user","content":"<text>"},"priority":"next"}`.
- Delivery semantics: an idle session starts a new turn; a busy session
  reads it between tool calls, mid-turn. Sessions in prompting permission
  modes (auto/default/acceptEdits) deliver; bypass-permissions sessions
  HOLD unless `crossSessionInbound: "accept"`. Inbox has burst refusal,
  duplicate drop, and a 50-message queue.

Spikes (2026-08-28, both passed, throwaways cleaned up):

- A plain non-agent python process posted a body to another session's
  socket by PID: post < 1 ms, idle -> busy in 0.5 s, body verbatim in the
  recipient transcript, model acted on it. No registry read on the send
  path, so the socket is account-agnostic even though `ListAgents` (which
  reads the per-account registry) is not.
- `rt agent start --extra-args "--name kai-test"` registered
  `name=kai-test, nameSource=user` and appeared in `/list-agents`.

herdr's snapshot already exposes each pane's Claude session id
(`agent_session`, reported by herdr's own SessionStart hook), so mapping
pane -> session -> socket needs no new Claude-side plumbing.

## Ratified decisions

| Decision | Choice |
| --- | --- |
| Delivery path | Inbox socket via the rt daemon; pty injection NOT on the Claude path |
| Scope | Full replacement, HARD CUTOVER: deletions land in the same change, no parity/soak period |
| Timing | Deliver immediately, always; `wake_on` prefs still gate what is delivered |
| Format | Compact `[#room] handle: body` lines; reply contract taught once in the sign-in welcome |
| Sign-in | herdr-chat on `pane.agent_detected` calls daemon-side `rt chat sign-in --pane` |
| Naming | Handle reserved before spawn; `claude --name <handle>` at launch; `/rename` injection deleted |
| Non-Claude fallback | Deferred seam, not built now |

## Design

### 1. Delivery

`postAndNotify` (`lib/daemon/handlers/chat.ts`) keeps its recipient
computation (`wake_on` all/mentions/none, `@here`, DMs) and replaces the
`chat/wake/<handle>` doorbell with direct socket delivery:

1. Resolve the recipient's socket (see Resolution below).
2. Build the content: one `[#room] sender: body` line per pending message
   for that recipient, batched into a single frame when several are
   pending (a delivery failure requeues, so the next attempt batches).
3. Connect, write the frame line, close. Sub-millisecond; no ack wait.
4. On success, advance the recipient's delivery cursor so catch-up and
   unread counts stay truthful. Read cursors (`chat:read`/`chat:mark`)
   are unchanged: delivered-to-context is not the same as read, but the
   delivered body IS the read surface for agents, so socket delivery also
   marks the messages read for that member (same as `rt chat read` would).

DMs render as `[dm] sender: body`. The human's mention desk-notification
path is unchanged.

**Resolution** (daemon-side, cached per handle at sign-in, re-resolved on
failure): presence row -> pane id -> herdr snapshot `agent_session.id` ->
scan the known registry dirs for the file whose `sessionId` matches ->
`messagingSocketPath` + pid. Registry dirs: `~/.claude/sessions` and each
`~/.claude-swap-backup/sessions/*/sessions`. A liveness check is
`kill -0 <pid>` plus socket connectability.

### 2. Sign-in, zero turns

`rt chat sign-in` grows a `--pane <paneId>` mode that runs entirely
daemon-side (no Claude turn):

1. herdr-chat's `pane.agent_detected` handler (Always path, and the Ask
   popup's confirm) runs `rt chat sign-in --pane <id>` instead of typing
   `/chat:sign-in` into the pane. Ask/Always/Never prefs and the popup UX
   are unchanged.
2. The daemon assigns the handle (existing LRU draw), writes presence,
   joins rooms, resolves the socket, and delivers the **welcome frame**:
   handle, rooms, the reply contract as two lines ("Reply in a room with:
   `rt chat post <room> \"...\"`"; "Reply privately with: `rt chat dm
   <handle> \"...\"`" -- one merged `<#room|@handle>` form does not
   actually parse as either command), that `rt chat read` shows a room's
   history, a pointer to the rt-chat skill for the full etiquette, and a
   bounded catch-up (last 10 unread per room, capped). The welcome is the
   one place the contract is taught; regular deliveries stay compact.
3. rt-spawned agents: `rt agent start` asks the daemon to reserve the
   handle before spawn and passes `--name <handle>` in the claude argv
   (`lib/agent-argv.ts`); the pid/sessionId land in the registry within
   seconds and sign-in binds them. Manual panes keep their own session
   name; the chat handle is chat-level and need not match.
4. The `/rename` injection (`lib/chat-rename.ts`) is deleted, including
   the headless `claude -p --resume` variant.

The in-session `/chat:sign-in` skill remains as a thin wrapper: it now
just runs `rt chat sign-in` (which detects its own pane via
`HERDR_PANE_ID` and behaves identically) and reports the handle; no
Monitor arm step.

### 3. Presence

- `live`: presence row bound to a registry entry whose pid is alive and
  whose socket connects. `busy`/`idle` mirror the registry `status`
  field for display in the viewer and peek.
- `offline`: signed out (SessionEnd hook, unchanged), pid dead, or socket
  gone at delivery time.
- **Deleted concepts**: `deaf`, `armedAt`/`tailSeenAt`, tail heartbeat,
  pulse freshness. `buddyStatus` reduces to the two states above plus the
  registry mirror.

### 4. Failure handling

A message is never lost: it is in the room log before delivery is
attempted. On delivery failure (connect refused, dead pid, inbox burst
refusal, or a bypass-mode session holding):

- The daemon marks the recipient's binding stale and retries on that
  recipient's next resolvable event (next post to them, or next sign-in).
- Unread counts surface in the viewer as today, plus a herdr badge:
  `herdr pane report-metadata --token chat_unread=<n> --ttl-ms 600000
  --seq <ns>` (renders once the sidebar format references the token; one
  documented config line).
- To avoid silent holds, `rt agent` adds `crossSessionInbound: "accept"`
  to the `--settings` it passes spawned sessions. Sessions Matt starts by
  hand in prompting modes deliver without it.
- `rt chat read` stays for manual catch-up and history.

### 5. Hard cutover: deletions in the same change

Landed atomically with the socket path (single release, no dual period):

- `rt chat tail` (`commands/chat.ts` step machinery, `TAIL_ROUND_MS`,
  `killChatTail`), the `chat:arm|touch|disarm|unread-waking` daemon verbs,
  and `wakeLine`.
- The Monitor arm: from `skills/rt-chat/SKILL.md` and the
  mattstack-marketplace chat plugin `sign-in`/`sign-out` skills (sign-out
  loses the TaskStop step).
- `hooks/pulse.sh` and the `UserPromptSubmit` hook entry; armed/deaf
  fields and thresholds in `lib/state/presence-store.ts`.
- `lib/chat-rename.ts` and its call in `commands/chat.ts`.
- Spec drift cleanup: the superseded sections of the 2026-08-23 and
  2026-08-24 specs get a pointer to this document.

The e2e test (below) is the safety net in place of a soak day; the room
log is the no-loss backstop throughout.

### 6. Deferred seams (documented, not built)

- **Non-Claude agents** (codex/cursor): delivery falls back to herdr
  `pane.send_input {pane_id, text, keys:["Enter"]}` (single pty write,
  bracketed paste). The delivery step gains a per-recipient `kind` switch
  where this slots in; until then non-Claude panes cannot sign in (they
  could not before either: sign-in is Claude-skill-driven).
- **Channels**: if custom MCP channels leave research preview, an rt-chat
  channel server (push + in-process `post` tool) can replace the socket
  writer behind the same daemon seam.
- The delivered-frame `content` stays plain text; the internal
  `<cross-session-message>` envelope is deliberately not spoofed.

### 7. Testing

- Unit (fake registry dir + fake Unix-socket server + fake herdr runner):
  resolution chain (pane -> session -> socket, account dirs, stale
  rebind), frame building and batching, read-cursor advance on delivery,
  failure marking, welcome content, handle reservation.
- E2e (the Spike A recipe, tagged, opt-in): spawn a throwaway
  `rt agent start` pane, post to a room it joined, assert the body
  appears in its transcript jsonl, tear down pane and registry entries.
- Skill docs: `skills/rt-chat/SKILL.md` shrinks to post/read/sign-out
  plus "messages arrive in your context; no arming".

## Risks

- The frame shape is Claude-internal (versioned `msgV: 1`, stable across
  the surveyed builds and identical to what the client itself sends). If
  a future Claude Code changes it, delivery fails loudly (connect works,
  message ignored) and the room log holds; pin a canary e2e test.
- Auto-mode classifier: sessions must not need to reference
  `CLAUDE_CODE_MESSAGING_TOKEN`; the daemon posts token-less (macOS
  accepts) from outside any session, which the spikes exercised.
- Interrupting busy agents is accepted by decision (deliver immediately);
  `wake_on mentions` remains the per-agent throttle if crosstalk annoys.
