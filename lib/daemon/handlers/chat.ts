/**
 * chat:* — daemon handlers for `rt chat` (RT-48 Task 6).
 * Thin validation + delegation; lib/state/chat-store.ts (and, for presence,
 * lib/state/presence-store.ts / dm-store.ts) owns every rule.
 */

import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import {
  ackMessage,
  claimMessage,
  releaseClaim,
  isValidChatName,
  joinRoom,
  leaveRoom,
  mergeMentions,
  postMessage,
  readUnread,
  peekUnread,
  listMessages,
  markRead,
  markDelivered,
  pendingMessages,
  stalePendingPairs,
  listRooms,
  archiveRoom,
  roomArchivedAt,
  roomDefaultWake,
  listMembers,
  dmRoomFor,
  dmParticipants,
  signIn,
  signOut,
  setAway,
  touchLastSeen,
  listBuddies,
  presenceForHandle,
  presenceForSession,
  assertSessionOwnsHandle,
  assertSessionSignedIn,
  buddyStatus,
  presenceThresholds,
  snapshotRegistryDeps,
  type BuddyStatus,
  type RegistryDeps,
  type WakeMode,
  type StalePendingRow,
} from "../../state/index.ts";
import { CHAT_NOTIFICATION_CATEGORY, notifyEnabled } from "../../notifier.ts";
import { chatViewerUrl, readChatViewerUrlSetting } from "../../chat-viewer-url.ts";
import { getSetting } from "../../settings/resolve.ts";
import { herdrRequest } from "../../herdr/client.ts";
import { injectIntoPane, herdrError } from "../inject.ts";
import type { HerdrSnapshot } from "./pane.ts";
import { resolveInbox, inboxAlive } from "../../claude-registry.ts";
import { deliverToInbox, deliveryLabel, renderDeliveries, REPLY_STEER, wrapCrossSession } from "../inbox.ts";
import { repoForCwd, branchForCwd } from "../../repo-for-cwd.ts";
import { deriveRoomForCwdAsync } from "../../chat-room.ts";
import { runCapture } from "../../subprocess.ts";
import { lazyChildLogger } from "../../daemon-logger.ts";
import type { Commands } from "../../../packages/rt-client/src/commands.ts";
import type { CommandResult } from "./types.ts";

export type InboxDeps = { resolve: typeof resolveInbox; deliver: typeof deliverToInbox };
const defaultInboxDeps: InboxDeps = { resolve: resolveInbox, deliver: deliverToInbox };
// Fallback only: real wiring threads ctx.log in from command-router.ts.
const defaultLog = lazyChildLogger("chat");

const CHAT_COMMANDS = [
  "chat:ack",
  "chat:claim",
  "chat:release",
  "chat:join",
  "chat:leave",
  "chat:post",
  "chat:read",
  "chat:rooms",
  "chat:who",
  "chat:mark",
  "chat:messages",
  "chat:sign-in",
  "chat:sign-out",
  "chat:away",
  "chat:back",
  "chat:buddies",
  "chat:dm",
  "chat:invite",
  "chat:archive",
  "chat:dm-open",
] as const;

/** Collapses the repeated try/catch every presence-assertion call site needs into one line: null on success, the refusal's message on throw. */
function assertionError(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Generous, not tight: bounds a single message body without constraining any real conversation. */
const MAX_BODY_BYTES = 64 * 1024;

function isValidBody(body: unknown): body is string {
  return typeof body === "string" && body.length > 0 && Buffer.byteLength(body, "utf8") <= MAX_BODY_BYTES;
}

/** Rooms `handle` already belongs to whose name is a prefix/suffix of the typo'd one — the common shape of a "deck" vs "deck-main" miss. */
function closestRoomNames(typo: string, handle: string, db: Database): string[] {
  const known = listRooms(handle, db, { includeArchived: true }).map((r) => r.room);
  return known.filter((r) => r.startsWith(typo) || typo.startsWith(r)).slice(0, 3);
}

/**
 * `limit: -1` reaches `ORDER BY id ASC LIMIT ?`, where SQLite treats a
 * negative LIMIT as unlimited, so a viewer/agent bug returns and
 * JSON-serializes an entire (100k-row) room on the event loop; a
 * non-numeric limit hits a datatype-mismatch SQLite error instead.
 * Mirrors the events handler's `num()` coercion pattern.
 */
const MAX_CHAT_LIMIT = 500;

function clampLimit(v: unknown, fallback: number): number {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_CHAT_LIMIT);
}

/** An unchecked value here lands on chat_members (and, on a join-creates, chat_room_defaults for every future joiner) and is silently treated as mention-only — never "none", never "all", never reported. */
const VALID_WAKE_ON = ["mention", "all", "none"] as const;

function isValidWakeOn(v: unknown): v is (typeof VALID_WAKE_ON)[number] {
  return typeof v === "string" && (VALID_WAKE_ON as readonly string[]).includes(v);
}

// herdr's report_metadata schema types `seq` as a uint64 INTEGER: a
// nanosecond-bigint string is rejected (invalid_request), and Date.now()
// alone repeats within the same millisecond -- either loses a badge, the
// first silently (herdr rejects it), the second because herdr drops a
// report whose seq does not advance. Monotonic and always a plain number:
// each call takes the greater of "now" and "one past the last seq sent."
let lastBadgeSeq = 0;
function nextBadgeSeq(): number {
  lastBadgeSeq = Math.max(Date.now(), lastBadgeSeq + 1);
  return lastBadgeSeq;
}

/**
 * Best-effort desk signal for a delivery the inbox socket never got: paints
 * the recipient's pane with an unread count through herdr so a failed push
 * isn't silent. No pane on presence (never signed in via `--pane`) means
 * nothing to paint, so this is a no-op rather than a guess. `herdrRequest`
 * never throws, but the try/catch is the contract this function promises
 * its caller regardless of that -- a badge that never lands must not break
 * message delivery.
 */
async function reportUnreadBadge(herdr: typeof herdrRequest, paneId: string | undefined, count: number): Promise<void> {
  if (!paneId) return;
  try {
    await herdr("pane.report_metadata", {
      pane_id: paneId,
      source: "rt-chat",
      // `count` is the failed delivery's OWN room, not a fleet-wide total:
      // each report_metadata call overwrites the `chat_unread` token
      // outright (herdr keeps only the latest value per source+pane), so a
      // second failure in a different room replaces rather than adds to
      // whatever the first one reported.
      tokens: { chat_unread: String(count) },
      ttl_ms: 600_000,
      seq: nextBadgeSeq(),
    });
  } catch {
    /* best-effort */
  }
}

// One immediate retry before falling back to badge+park: cheap insurance
// against exactly the transient this file was built to survive (recipient
// briefly under load, not actually gone). Overridable so a test doesn't pay
// the real delay.
const DEFAULT_RETRY_DELAY_MS = 300;

/**
 * A resolver miss, a signed-out recipient, a dead binding, and a
 * still-failing-after-retry send are all the same outcome here: no cursor
 * advance. Recovery now has three layers, in order: this function's own
 * retry (a transient push failure self-heals invisibly, same call), a later
 * post to the same recipient (via pendingMessages, catches up everything
 * still behind the cursor -- not just its own message), and the periodic
 * delivery sweep for the case neither of those arrives (see
 * createChatDeliverySweep) -- a 2-party DM at a wait-point may never get a
 * "later post" from either side, so the sweep is not optional belt-and-
 * suspenders, it is what makes that case recover at all. This function does
 * not defend against a concurrent call for the same (room, handle): two
 * overlapping calls would both read the same pre-advance pending range and
 * duplicate it into two frames. Callers must go through deliverSerialized,
 * never call this directly from postAndNotify or the sweep.
 */
async function deliverPost(
  db: Database,
  deps: InboxDeps,
  herdr: typeof herdrRequest,
  log: Logger,
  retryDelayMs: number,
  recipient: string,
  msg: { room: string; dm: boolean; id: number },
): Promise<{ delivered: boolean; count: number }> {
  const presence = presenceForHandle(recipient, db);
  if (!presence || presence.signedOutAt !== undefined) return { delivered: false, count: 0 };
  const binding = deps.resolve(presence.sessionId);
  if (!binding || !inboxAlive(binding)) return { delivered: false, count: 0 };
  const pending = pendingMessages(msg.room, recipient, msg.id, db);
  // postMessage never self-advances the author's cursor, so a recipient's own
  // posts stay in their pending range and every later bundle would render them
  // back into their own pane. Presentational only -- markDelivered below still
  // advances the cursor past them.
  const others = pending.filter((m) => m.handle !== recipient);
  if (others.length === 0) return { delivered: false, count: 0 };
  const items = others.map((m) => ({ room: msg.room, dm: msg.dm, handle: m.handle, body: m.body, id: m.id }));
  const content = wrapCrossSession(deliveryLabel(items), `${renderDeliveries(items)}\n${REPLY_STEER}`);
  let result = await deps.deliver(binding.socketPath, content);
  if (!result.ok) {
    await Bun.sleep(retryDelayMs);
    result = await deps.deliver(binding.socketPath, content);
  }
  if (!result.ok) {
    // The error STRING (e.g. "timeout" vs a connect errno), not just a
    // boolean -- this is exactly what the incident's silent hour lacked.
    log.warn({ recipient, room: msg.room, err: result.error }, "chat: delivery push failed after retry");
    await reportUnreadBadge(herdr, presence.pane, others.length);
    return { delivered: false, count: 0 };
  }
  markDelivered(msg.room, recipient, msg.id, db);
  // Refreshes the SESSION heartbeat -- the only remaining route to it now
  // that chat:pulse is gone -- so a recipient actively receiving messages
  // never goes stale enough for prunePresence to delete its row.
  touchLastSeen(presence.sessionId, Date.now(), db);
  return { delivered: true, count: others.length };
}

const ACK_BODY_PREVIEW = 80;

/**
 * A receipt, not a message: no chat_messages row, no cursor movement, no room
 * fan-out. It reaches exactly one inbox, the author's, which is the whole
 * point -- acknowledging costs one wake instead of the room-wide one a posted
 * "ack" costs. The preview is whitespace-collapsed so a heredoc body cannot
 * turn a one-line receipt into a paragraph.
 */
async function deliverReceipt(
  db: Database,
  deps: InboxDeps,
  log: Logger,
  args: { to: string; from: string; kind: "ack" | "claim"; text: string; messageId: number },
): Promise<void> {
  const { to, from, kind, text, messageId } = args;
  const presence = presenceForHandle(to, db);
  if (!presence || presence.signedOutAt !== undefined) return;
  const binding = deps.resolve(presence.sessionId);
  if (!binding || !inboxAlive(binding)) return;
  const result = await deps.deliver(binding.socketPath, wrapCrossSession(`${from} (${kind})`, text));
  if (!result.ok) log.warn({ to, from, id: messageId, err: result.error }, `chat: ${kind} receipt push failed`);
}

function previewBody(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > ACK_BODY_PREVIEW ? `${flat.slice(0, ACK_BODY_PREVIEW)}...` : flat;
}

function deliverAck(
  db: Database,
  deps: InboxDeps,
  log: Logger,
  args: { author: string; acker: string; messageId: number; body: string },
): Promise<void> {
  const { author, acker, messageId, body } = args;
  const text = `${acker} acknowledged your message #${messageId}: "${previewBody(body)}"`;
  return deliverReceipt(db, deps, log, { to: author, from: acker, kind: "ack", text, messageId });
}

/**
 * A won claim receipts the author (so an asker knows who is on it during the
 * minutes before the answer lands); a takeover of an expired claim also
 * receipts the previous holder, who may still be alive and composing. Losers
 * and re-claims of a held id wake nobody: silence is the whole point.
 */
async function deliverClaim(
  db: Database,
  deps: InboxDeps,
  log: Logger,
  args: { author: string; claimer: string; messageId: number; body: string; previousHolder?: string },
): Promise<void> {
  const { author, claimer, messageId, body, previousHolder } = args;
  const preview = previewBody(body);
  const takeover = previousHolder ? ` (took over from ${previousHolder})` : "";
  await deliverReceipt(db, deps, log, {
    to: author,
    from: claimer,
    kind: "claim",
    text: `${claimer} claimed your message #${messageId}${takeover}: "${preview}"`,
    messageId,
  });
  if (!previousHolder) return;
  await deliverReceipt(db, deps, log, {
    to: previousHolder,
    from: claimer,
    kind: "claim",
    text: `${claimer} took over #${messageId} from you: "${preview}"`,
    messageId,
  });
}

function chainKey(room: string, handle: string): string {
  return `${room}:${handle}`;
}

/**
 * Runs `task` serialized per `key`: a delivery landing while an earlier one
 * for the same key is still in flight must wait for it rather than run
 * concurrently -- for message delivery that would read pendingMessages
 * against the same pre-advance cursor and duplicate a frame. The
 * predecessor's failure is swallowed before chaining, so one failure never
 * blocks the next. The map entry is deleted once nothing is chained behind
 * it, so a quiet key leaves no permanent entry. Generic over `task`'s result
 * so a caller (the delivery sweep) can read back what happened -- the chain
 * bookkeeping itself only ever needs to know settlement, never the value.
 */
function serializeDelivery<T>(chains: Map<string, Promise<void>>, key: string, task: () => Promise<T>): Promise<T> {
  const prior = chains.get(key) ?? Promise.resolve();
  const result = prior.catch(() => {}).then(() => task());
  const swallowed: Promise<void> = result.then(() => undefined, () => undefined);
  chains.set(key, swallowed);
  void swallowed.finally(() => {
    if (chains.get(key) === swallowed) chains.delete(key);
  });
  return result;
}

function deliverSerialized(
  chains: Map<string, Promise<void>>,
  db: Database,
  deps: InboxDeps,
  herdr: typeof herdrRequest,
  log: Logger,
  retryDelayMs: number,
  recipient: string,
  msg: { room: string; dm: boolean; id: number },
): Promise<{ delivered: boolean; count: number }> {
  return serializeDelivery(chains, chainKey(msg.room, recipient), () =>
    deliverPost(db, deps, herdr, log, retryDelayMs, recipient, msg),
  );
}

/** The presence shape planSweepTargets actually needs -- a subset of PresenceRow, spelled out so the planner stays pure and testable with plain object literals instead of a full store row. */
type SweepPresence = { sessionId: string; signedOutAt?: number };

/**
 * Pure: given stalePendingPairs' raw candidates plus a presence snapshot and
 * which of those sessions have an alive registry binding, decides which
 * pairs are actually worth re-invoking delivery for. A candidate with no
 * presence row, a signed-out one, or a signed-in one whose binding is dead
 * is dropped -- deliverPost would reach the same conclusion itself, but
 * checking here means the sweep never even builds a delivery chain entry
 * for a candidate that can't receive anything. A wake_on:"none" candidate is
 * also dropped here, cheaply and unconditionally: no pending message can
 * ever make a "none" member a recipient, so there is nothing a per-message
 * check downstream could find. wake_on:"mention" is NOT resolved here --
 * that needs each pending message's author/mentions, which this function
 * deliberately does not have; see pendingIncludesRecipient, applied once
 * pendingMessages is fetched for a candidate that survives this filter.
 *
 * Takes stalePendingPairs' own row type directly (not a locally-declared
 * shape) so the planner's candidate contract can never silently drift from
 * what the store actually returns.
 */
export function planSweepTargets(
  stale: StalePendingRow[],
  presenceByHandle: Map<string, SweepPresence>,
  aliveSessionIds: Set<string>,
): StalePendingRow[] {
  return stale.filter((pair) => {
    if (pair.wakeOn === "none") return false;
    const presence = presenceByHandle.get(pair.handle);
    if (!presence || presence.signedOutAt !== undefined) return false;
    return aliveSessionIds.has(presence.sessionId);
  });
}

/**
 * Mirrors recipientsFromMembers' per-member filter (lib/state/chat-store.ts)
 * applied to one already-fetched message instead of a room's member list:
 * true when `handle` would have been a recipient of `message` under the
 * normal push rules for `wakeOn` (never the author; never a quiet post, which
 * may only ride along in a bundle another message causes; "all" is
 * unconditional; "mention" needs an exact handle mention or @here).
 */
function isRecipientUnderWakeRules(message: { handle: string; mentions: string[]; quiet?: boolean }, handle: string, wakeOn: WakeMode): boolean {
  if (message.handle === handle || message.quiet || wakeOn === "none") return false;
  return wakeOn === "all" || message.mentions.includes("here") || message.mentions.includes(handle);
}

/**
 * True when at least one of `pending` would have named `handle` a recipient
 * under `wakeOn` -- the sweep's own analog of recipientsFor, needed because
 * (unlike a normal post, which only ever calls deliverPost for handles
 * recipientsFor already vetted) a sweep candidate arrives with no such
 * guarantee. Bundling still delivers the WHOLE pending range once this gate
 * passes, same as a normal post's own catch-up batching -- this only
 * decides whether the recipient should be swept at all, not which
 * individual messages in the batch they "should" see.
 */
export function pendingIncludesRecipient(pending: Array<{ handle: string; mentions: string[]; quiet?: boolean }>, handle: string, wakeOn: WakeMode): boolean {
  return pending.some((m) => isRecipientUnderWakeRules(m, handle, wakeOn));
}

/**
 * The daemon's periodic delivery sweep (the deadlock fix): finds every
 * (room, handle) whose cursor is behind that room's newest message via
 * stalePendingPairs, keeps only the ones planSweepTargets says a live
 * recipient could receive, and re-invokes the SAME deliverSerialized path a
 * normal post uses -- this and postAndNotify are the only two callers.
 * Sharing `deliveryChains` with createChatHandlers (see that factory's
 * `deliveryChains` opt) is what keeps a sweep re-delivery from racing a
 * post's own in-flight delivery to the same recipient.
 *
 * stalePendingPairs already excludes a self-authored-only backlog (its own
 * EXISTS clause), and planSweepTargets/pendingIncludesRecipient exclude
 * everything wake_on rules out -- so every target this function ever calls
 * deliverSerialized for is one a normal push would also have delivered to.
 */
/** How many consecutive sweep-triggered failures a (room, handle) pair tolerates before the sweep starts backing off it -- a permanently-broken pair must not cost a fresh deliverPost attempt (retry + warn log) on every tick forever. */
const DEFAULT_MAX_CONSECUTIVE_SWEEP_FAILURES = 5;

/**
 * Backoff, once past the ceiling, doubles per further failure (2^(count -
 * max) ticks) and saturates here -- about 60 minutes at the daemon's
 * current 30s sweep interval. The ceiling is a THROTTLE, never a permanent
 * stop: "eventually delivered" is the invariant a 2-party DM wait-point
 * depends on (the incident's own shape -- nobody posts again to shake a
 * stuck pair loose), so a saturated pair still gets retried roughly hourly
 * forever, not muted outright.
 */
const MAX_SWEEP_BACKOFF_TICKS = 120;

/**
 * The failure streak is scoped to the maxId it was accumulated against, not
 * just the (room, handle) pair: a pair backing off while stuck on an old
 * message gets a fresh streak the moment a NEWER message makes it stale
 * again (the room's maxId advanced), since that is a materially different
 * situation worth its own immediate attempt -- deliverPost bundles the
 * whole pending range regardless, so the new message deserves its own
 * chance rather than inheriting an old backoff window that had nothing to
 * do with it. `skipUntilTick` is only ever meaningful once `count` has
 * reached the ceiling; below it, every tick attempts.
 */
type SweepFailureEntry = { count: number; maxId: number; skipUntilTick: number };

/**
 * Records one sweep-triggered failure for `key` and returns whether this is
 * the exact tick the streak crossed the ceiling (the caller's cue to warn
 * once, not on every later backed-off retry that also fails).
 */
function recordSweepFailure(
  failureCounts: Map<string, SweepFailureEntry>,
  key: string,
  entry: SweepFailureEntry | undefined,
  target: StalePendingRow,
  tick: number,
  maxConsecutiveFailures: number,
): { crossedCeiling: boolean; count: number } {
  const priorStreak = entry && entry.maxId === target.maxId ? entry.count : 0;
  const count = priorStreak + 1;
  let skipUntilTick = tick;
  if (count >= maxConsecutiveFailures) {
    const backoffTicks = Math.min(2 ** (count - maxConsecutiveFailures), MAX_SWEEP_BACKOFF_TICKS);
    skipUntilTick = tick + backoffTicks;
  }
  failureCounts.set(key, { count, maxId: target.maxId, skipUntilTick });
  return { crossedCeiling: priorStreak < maxConsecutiveFailures && count >= maxConsecutiveFailures, count };
}

export function createChatDeliverySweep(opts: {
  db: Database;
  deliveryChains: Map<string, Promise<void>>;
  herdr?: typeof herdrRequest;
  inboxDeps?: InboxDeps;
  /** The registry probe for the sweep's OWN presence/binding pre-check, snapshotted once per run via snapshotRegistryDeps -- deliberately separate from `inboxDeps.resolve`, which stays a per-recipient call at actual delivery time (deliverPost). Real by default, fakeable the same way createChatHandlers' registryDeps is. */
  registryDeps?: RegistryDeps;
  log?: Logger;
  retryDelayMs?: number;
  /** Overridable so a test doesn't need to run a real 5-tick failure streak. */
  maxConsecutiveFailures?: number;
}): () => Promise<{ sweptPairs: number; recoveredMessages: number }> {
  const { db, deliveryChains } = opts;
  const herdr = opts.herdr ?? herdrRequest;
  const inboxDeps = opts.inboxDeps ?? defaultInboxDeps;
  const log = opts.log ?? defaultLog;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxConsecutiveFailures = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_SWEEP_FAILURES;
  // One map per sweep instance (one daemon), persisting across ticks --
  // that persistence is the whole point: a streak must survive from one
  // scheduleSweep call to the next to ever reach the ceiling and back off.
  const failureCounts = new Map<string, SweepFailureEntry>();
  // One tick per sweepPendingDeliveries() call -- the backoff clock. Counting
  // invocations rather than wall-clock time keeps the whole mechanism
  // deterministic for a test calling sweep() directly, independent of
  // whatever real interval scheduleSweep ends up driving it at.
  let tick = 0;
  // scheduleSweep drives this off a bare setInterval that never awaits the
  // tick, and one run is sequential over its targets at up to a retry pair
  // of inbox timeouts each -- so a slow run CAN outlive the interval. Two
  // overlapping runs would share `tick` (draining a backoff window in half
  // the wall-clock time it encodes) and interleave their read-modify-write
  // of `failureCounts`, letting a stale `entry` clobber the other run's
  // streak. Skipping is always safe: the next tick rescans from the store.
  let inFlight = false;

  return async function sweepPendingDeliveries(): Promise<{ sweptPairs: number; recoveredMessages: number }> {
    if (inFlight) return { sweptPairs: 0, recoveredMessages: 0 };
    inFlight = true;
    try {
      return await runSweep();
    } finally {
      inFlight = false;
    }
  };

  async function runSweep(): Promise<{ sweptPairs: number; recoveredMessages: number }> {
    tick += 1;
    const stale = stalePendingPairs(db);
    if (stale.length === 0) {
      failureCounts.clear(); // nothing stale at all: no streak is worth remembering
      return { sweptPairs: 0, recoveredMessages: 0 };
    }
    // Forget a pair's streak once it's no longer a stale candidate at all --
    // resolved through ANY path (a normal post succeeding, the member
    // leaving, wake_on changing), not just a sweep-triggered success.
    const staleKeys = new Set(stale.map((p) => chainKey(p.room, p.handle)));
    for (const key of failureCounts.keys()) {
      if (!staleKeys.has(key)) failureCounts.delete(key);
    }

    const presenceByHandle = new Map<string, SweepPresence>();
    for (const { handle } of stale) {
      if (presenceByHandle.has(handle)) continue;
      const presence = presenceForHandle(handle, db);
      if (presence) presenceByHandle.set(handle, presence);
    }
    // ONE registry scan for the whole run (snapshotRegistryDeps calls
    // deps.resolveAll() exactly once), not one resolveInbox call per stale
    // candidate -- resolveInbox itself is resolveAllInboxes().get(id), so a
    // per-candidate loop would have re-scanned the whole registry directory
    // per candidate (claude-registry.ts's own doc on resolveAllInboxes
    // names this exact multi-lookup case). Skipped entirely when no stale
    // handle has a presence row at all -- nothing could resolve regardless
    // of what the registry says, so the scan itself would be wasted work.
    // A signed-out presence is skipped before even doing the (now cheap,
    // in-memory) alive check -- its binding can never matter either.
    const aliveSessionIds = new Set<string>();
    if (presenceByHandle.size > 0) {
      const scoped = snapshotRegistryDeps(opts.registryDeps);
      for (const presence of presenceByHandle.values()) {
        if (presence.signedOutAt !== undefined) continue;
        const binding = scoped.resolve(presence.sessionId);
        if (binding && scoped.alive(binding)) aliveSessionIds.add(presence.sessionId);
      }
    }

    const targets = planSweepTargets(stale, presenceByHandle, aliveSessionIds);
    let sweptPairs = 0;
    let recoveredMessages = 0;
    for (const target of targets) {
      const pending = pendingMessages(target.room, target.handle, target.maxId, db);
      if (!pendingIncludesRecipient(pending, target.handle, target.wakeOn)) continue;

      const key = chainKey(target.room, target.handle);
      const entry = failureCounts.get(key);
      const backingOff = entry && entry.maxId === target.maxId && entry.count >= maxConsecutiveFailures;
      if (backingOff && tick <= entry.skipUntilTick) {
        log.debug({ recipient: target.handle, room: target.room, consecutiveFailures: entry.count, retryTick: entry.skipUntilTick + 1 }, "chat: sweep backing off a pair past its consecutive-failure ceiling");
        continue;
      }

      const noteFailure = () => {
        const { crossedCeiling, count } = recordSweepFailure(failureCounts, key, entry, target, tick, maxConsecutiveFailures);
        if (crossedCeiling) {
          log.warn({ recipient: target.handle, room: target.room, consecutiveFailures: count }, "chat: sweep pair crossed its consecutive-failure ceiling; backing off, never permanently stopping");
        }
      };
      const dm = dmParticipants(target.room, db) !== null;
      sweptPairs++;
      try {
        const result = await deliverSerialized(
          deliveryChains, db, inboxDeps, herdr, log, retryDelayMs, target.handle,
          { room: target.room, dm, id: target.maxId },
        );
        if (result.delivered) {
          failureCounts.delete(key);
          recoveredMessages += result.count;
          log.info({ recipient: target.handle, room: target.room, recovered: result.count }, "chat: sweep recovered a stale delivery");
        } else {
          noteFailure();
        }
      } catch (err) {
        // One target's delivery throwing (a programming error, a DB hiccup)
        // must not abort the rest of this tick's targets.
        noteFailure();
        log.warn({ err, recipient: target.handle, room: target.room }, "chat: sweep delivery threw; continuing with the remaining targets");
      }
    }
    return { sweptPairs, recoveredMessages };
  }
}

// Not a real room -- isValidChatName forbids '_' -- so this key can never
// collide with a genuine (room, handle) delivery chain. Deliberately its OWN
// chain, not the joined room's: the welcome is never ordered against a post
// delivery to the same recipient, only against another welcome for the same
// handle (a fast sign-out/sign-in pair) -- there is no correctness
// requirement that "you're signed in" land before or after a room message
// that happens to arrive the same tick, unlike two posts to the same room,
// which must not race past pendingMessages' shared cursor.
const WELCOME_CHAIN_ROOM = "__welcome__";
const WELCOME_CATCHUP_LIMIT = 10;

/**
 * Mirrors deliverPost's contract: an unresolvable/dead binding or a failed
 * send is silently skipped and, critically, never advances a cursor.
 * `catchupCursors` is the caller's peek of what the welcome's catch-up
 * section actually shows (peekUnread, not readUnread -- see renderWelcome's
 * caller) -- only a confirmed-delivered welcome may mark that range read, or
 * a welcome that never arrived would still have "shown" it.
 */
async function deliverWelcomeOnce(
  db: Database,
  deps: InboxDeps,
  sessionId: string,
  handle: string,
  content: string,
  catchupCursors: Array<{ room: string; upToId: number }>,
): Promise<void> {
  const binding = deps.resolve(sessionId);
  if (!binding || !inboxAlive(binding)) return;
  const result = await deps.deliver(binding.socketPath, content);
  if (!result.ok) return;
  for (const { room, upToId } of catchupCursors) markDelivered(room, handle, upToId, db);
  touchLastSeen(sessionId, Date.now(), db);
}

function deliverWelcome(
  db: Database,
  chains: Map<string, Promise<void>>,
  deps: InboxDeps,
  sessionId: string,
  handle: string,
  content: string,
  catchupCursors: Array<{ room: string; upToId: number }>,
): Promise<void> {
  return serializeDelivery(chains, chainKey(WELCOME_CHAIN_ROOM, handle), () =>
    deliverWelcomeOnce(db, deps, sessionId, handle, content, catchupCursors),
  );
}

/**
 * The frame a freshly signed-in member gets, once, in place of the manual
 * "arm your tail" instruction: it explains that delivery is automatic and
 * carries whatever unread was already waiting in the rooms sign-in found the
 * handle already a member of. `catchup` entries with no lines (nothing
 * unread in that room) are skipped. The reply contract is two lines, not
 * one: `rt chat post <room>` and `rt chat dm <handle>` take different first
 * arguments, so one merged `<#room|@handle>` form does not actually parse.
 */
export function renderWelcome(handle: string, rooms: string[], catchup: Array<{ room: string; lines: string[] }>): string {
  const lines: string[] = [
    "[rt chat] This frame is for THIS session, from the rt daemon (not another agent).",
    `You're signed in to rt chat as ${handle}.`,
    rooms.length ? `Rooms: ${rooms.map((r) => `#${r}`).join(", ")}` : "Rooms: none yet.",
    "Messages will arrive in your context automatically; you never need to poll or arm anything.",
    'Reply in a room with: rt chat post <room> "..."',
    'Reply privately with: rt chat dm <handle> "..."',
    "Chat replies go through rt chat only, never SendMessage, even though deliveries arrive framed as coming from another session.",
    "rt chat read shows a room's history.",
    "See the rt:chat skill for the full etiquette.",
  ];
  for (const entry of catchup) {
    const capped = entry.lines.slice(0, WELCOME_CATCHUP_LIMIT);
    if (capped.length === 0) continue;
    lines.push(`#${entry.room} catch-up:`);
    for (const line of capped) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}

/**
 * Herdr's own `pane:list` join (lib/daemon/handlers/pane.ts) reads
 * `agent_session.value` for its "which session is this pane" answer; sign-in
 * `--pane` needs the exact same fact, so it takes the identical snapshot
 * shape rather than growing a second reader. Pure (no herdr call): the
 * caller fetches the snapshot itself, so a herdr-unreachable failure and a
 * "found the pane, no claude session" miss stay distinguishable instead of
 * collapsing into one null.
 */
function findPaneSession(snapshot: HerdrSnapshot, paneId: string): { sessionId: string; cwd?: string } | null {
  const pane = snapshot.panes.find((p) => p.pane_id === paneId);
  if (!pane || pane.agent_session?.kind !== "id") return null;
  return { sessionId: pane.agent_session.value, cwd: pane.foreground_cwd ?? pane.cwd };
}

// Mirrors pane.ts's REGISTER_BUDGET_MS/REGISTER_POLL_MS wait: a few seconds
// at a short poll, bounded by wall-clock rather than an attempt count.
const PANE_SESSION_BUDGET_MS = 3000;
const PANE_SESSION_POLL_MS = 200;

/**
 * `findPaneSession`, re-polled: herdr-chat calls `sign-in --pane` right as a
 * pane starts, the exact window herdr has not yet reported that pane's
 * `agent_session` in a snapshot. An immediate miss is not yet a real
 * "no session" answer, so this re-fetches the snapshot until one appears or
 * the budget runs out. A herdr-unreachable failure is NOT retried -- that is
 * a different failure than a not-yet-registered session, and retrying it
 * would only spend the budget on a snapshot call that keeps failing the
 * same way.
 */
async function findPaneSessionRetrying(
  herdr: typeof herdrRequest,
  paneId: string,
  budgetMs: number,
  pollMs: number,
): Promise<{ ok: true; session: { sessionId: string; cwd?: string } } | { ok: false; error: string }> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const snap = await herdr<{ snapshot: HerdrSnapshot }>("session.snapshot", {});
    if (!snap.ok) return herdrError(snap);
    const resolved = findPaneSession(snap.result.snapshot, paneId);
    if (resolved) return { ok: true, session: resolved };
    if (Date.now() >= deadline) return { ok: false, error: `chat: no Claude session found for pane "${paneId}"` };
    await Bun.sleep(pollMs);
  }
}

/**
 * The row must commit before the viewer's `chat/<room>/msg` emit fires, or a
 * viewer reading the event finds no message yet. Shared by chat:post and
 * chat:dm so the desk-notify check (mentions merged the same way postMessage
 * merges them for storage) never diverges between the two entry points.
 * Recipient delivery is deferred a microtask past this function's return:
 * presenceForHandle plus a full registry scan run per recipient, and a
 * queued call lets chat:post's response get built before that work starts,
 * rather than paying it inline on the request path.
 */
function postAndNotify(
  db: Database,
  emitEvent: (topic: string, payload?: unknown) => unknown,
  args: { room: string; handle: string; body: string; mentions?: string[]; quiet?: boolean },
  inboxDeps: InboxDeps,
  herdr: typeof herdrRequest,
  deliveryChains: Map<string, Promise<void>>,
  log: Logger,
  retryDelayMs: number,
): { id: number; recipients: string[] } | undefined {
  const { room, handle, body, mentions, quiet } = args;
  const posted = postMessage({ room, handle, body, mentions, quiet }, db);
  if (!posted) return undefined;
  // The row is durable at this point. The msg emit is best-effort: a throw
  // here (a full disk, an orphan daemon holding an events.db lock) must
  // never surface as a failed post — the caller would retry and post the
  // message twice.
  try {
    emitEvent(`chat/${room}/msg`, { id: posted.id });
  } catch (err) {
    log.warn({ err, id: posted.id, room }, "chat: emit for the posted message threw; message is durable, this emit was not");
  }
  const dm = dmParticipants(room, db);
  // A quiet post is the record without the interruption: it stays unread (so
  // peek and the viewer still surface it) and catches up inside whatever
  // bundle a later ordinary message causes, but it wakes nobody itself --
  // neither an agent's inbox below nor the human's desk further down.
  if (quiet) return { id: posted.id, recipients: [] };
  for (const recipient of posted.recipients) {
    queueMicrotask(() => {
      deliverSerialized(deliveryChains, db, inboxDeps, herdr, log, retryDelayMs, recipient, { room, dm: dm !== null, id: posted.id }).catch((err) => {
        log.warn({ err, room, recipient, id: posted.id }, "chat: inbox delivery failed");
      });
    });
  }
  // Independent of chat_members / wake_on: agents create rooms via
  // join-creates, so the human is typically not a member yet, and a
  // member with wake_on='none' must still get a desk alert.
  const humanHandle = getSetting<string>("chat.humanHandle").value;
  const allMentions = mergeMentions(body, mentions);
  if (humanHandle && allMentions.includes(humanHandle)) {
    try {
      const title = dm ? `DM from ${handle}` : `#${room}`;
      // The click target: the viewer at this exact message, when the viewer is
      // configured. The tray opens `url` on a default click for any category.
      notifyEnabled(
        CHAT_NOTIFICATION_CATEGORY,
        title,
        `${handle}: ${body}`,
        chatViewerUrl(readChatViewerUrlSetting(), room, posted.id),
        undefined,
        `chat:${posted.id}`,
      );
    } catch (err) {
      log.warn({ err, id: posted.id, room }, "chat: desk notify threw after a successful post");
    }
  }
  return posted;
}

/** One line, because Claude Code dispatches a slash command from the first line only. */
export function inviteText(room: string, from: string, note?: string): string {
  const head = `/chat:join ${room}`;
  const body = note?.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();
  return body ? `${head} note from ${from}: ${body}` : head;
}

export function createChatHandlers(opts: {
  db: Database;
  emitEvent: (topic: string, payload?: unknown) => unknown;
  herdr?: typeof herdrRequest;
  inboxDeps?: InboxDeps;
  /** The registry probe behind buddyStatus (chat:who, chat:buddies) and signIn's reclaim check; real by default, fakeable the same way inboxDeps is. */
  registryDeps?: RegistryDeps;
  /** repo/branch/room derivation for `--pane` sign-in (lib/repo-for-cwd.ts, the same index-based, no-sync-git-spawn source pane.ts's own paneRow uses). */
  repoIndex?: () => Record<string, string>;
  exec?: typeof runCapture;
  /** `findPaneSessionRetrying`'s wall-clock budget/poll; overridable so a test whose fake herdr never resolves does not have to wait out the real production budget. */
  paneSessionBudgetMs?: number;
  paneSessionPollMs?: number;
  /** Request logger; wired from ctx.log by command-router.ts. */
  log?: Logger;
  /** deliverPost's single-retry delay; overridable so a test doesn't pay the real ~300ms. */
  retryDelayMs?: number;
  /** Shared with createChatDeliverySweep so the periodic sweep chains behind the same in-flight post deliveries instead of racing them; defaults to a private map when the caller (a bare createChatHandlers test) has no sweep. */
  deliveryChains?: Map<string, Promise<void>>;
}): {
  // A mapped type over CHAT_COMMANDS with a direct `unknown` payload, not
  // `Pick<TypedHandlers, ...>`: a wider `unknown` param still satisfies
  // TypedHandlers' narrower one at the command-router.ts assembly site
  // (function parameter contravariance).
  [K in (typeof CHAT_COMMANDS)[number]]: (payload: unknown) => Promise<CommandResult<K>>;
} {
  const { db, emitEvent } = opts;
  const log = opts.log ?? defaultLog;
  const herdr = opts.herdr ?? herdrRequest;
  const inboxDeps = opts.inboxDeps ?? defaultInboxDeps;
  const registryDeps = opts.registryDeps;
  const repoIndex = opts.repoIndex ?? (() => ({}));
  const exec = opts.exec ?? runCapture;
  const paneSessionBudgetMs = opts.paneSessionBudgetMs ?? PANE_SESSION_BUDGET_MS;
  const paneSessionPollMs = opts.paneSessionPollMs ?? PANE_SESSION_POLL_MS;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  // One chain map per handler instance (one daemon, one db): shared across
  // every chat:post/chat:dm call so deliverSerialized actually serializes.
  // Also shared with the delivery sweep when the caller passes one in, so a
  // sweep re-delivery chains behind rather than races an in-flight post.
  const deliveryChains = opts.deliveryChains ?? new Map<string, Promise<void>>();

  return {
    "chat:join": async (rawPayload: unknown): Promise<CommandResult<"chat:join">> => {
      if (!rawPayload || typeof rawPayload !== "object") return { ok: false, error: "chat:join requires an object payload" };
      const payload = rawPayload as Commands["chat:join"]["payload"];
      const { room, handle, wakeOn, cwd, pane } = payload;
      if (!isValidChatName(handle)) return { ok: false, error: `invalid handle "${handle}"` };
      if (!isValidChatName(room)) return { ok: false, error: `invalid room "${room}"` };
      if (wakeOn !== undefined && !isValidWakeOn(wakeOn)) {
        return { ok: false, error: `invalid wakeOn "${wakeOn}"; must be one of ${VALID_WAKE_ON.join(", ")}` };
      }
      try {
        const data = joinRoom({ room, handle, wakeOn, cwd, pane }, db);
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    "chat:leave": async (rawPayload: unknown): Promise<CommandResult<"chat:leave">> => {
      const payload = rawPayload as Commands["chat:leave"]["payload"];
      leaveRoom(payload.room, payload.handle, db);
      return { ok: true, data: {} };
    },

    "chat:post": async (rawPayload: unknown): Promise<CommandResult<"chat:post">> => {
      const payload = rawPayload as Commands["chat:post"]["payload"];
      const { room, handle, body, mentions, quiet } = payload;
      if (!isValidChatName(room)) return { ok: false, error: `invalid room "${room}"` };
      if (!isValidChatName(handle)) return { ok: false, error: `invalid handle "${handle}"` };
      if (!isValidBody(body)) return { ok: false, error: `body must be a non-empty string under ${MAX_BODY_BYTES} bytes` };
      if (mentions !== undefined && !Array.isArray(mentions)) return { ok: false, error: "mentions must be an array of handles" };
      // Rejected rather than coerced: a truthy non-boolean (the string
      // "false", say) would silently suppress every wake this post owes.
      if (quiet !== undefined && typeof quiet !== "boolean") return { ok: false, error: "quiet must be a boolean" };
      const invalidMention = mentions?.find((m) => !isValidChatName(m));
      if (invalidMention !== undefined) return { ok: false, error: `invalid handle "${invalidMention}"` };
      // A typo'd room previously no-op'd through postMessage's REVIVE (a
      // no-op for a room with no chat_rooms row) and returned ok with no
      // recipients — unreachable except by the exact typo'd name.
      if (roomArchivedAt(room, db) === undefined) {
        const nearby = closestRoomNames(room, handle, db);
        return { ok: false, error: `unknown room "${room}"${nearby.length ? ` — did you mean: ${nearby.join(", ")}` : ""}` };
      }
      // The human's post is the coordinator's: it wakes the whole room without
      // him having to mention anyone. Stored as an explicit @here so the live
      // push, the sweep, and the record all see the same thing. Rooms default
      // to wake-on mention, so an agent's un-addressed post wakes nobody.
      const effectiveMentions = handle === getSetting<string>("chat.humanHandle").value ? [...(mentions ?? []), "here"] : mentions;
      const posted = postAndNotify(db, emitEvent, { room, handle, body, mentions: effectiveMentions, quiet }, inboxDeps, herdr, deliveryChains, log, retryDelayMs);
      if (!posted) return { ok: false, error: "chat: post failed (retry budget exhausted)" };
      const others = listMembers(room, db).filter((m) => m.handle !== handle).length;
      return { ok: true, data: { ...posted, others } };
    },

    "chat:ack": async (rawPayload: unknown): Promise<CommandResult<"chat:ack">> => {
      const payload = rawPayload as Commands["chat:ack"]["payload"];
      const { id, handle } = payload;
      if (!isValidChatName(handle)) return { ok: false, error: `invalid handle "${handle}"` };
      if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "id must be a positive message id" };
      const res = ackMessage({ messageId: id, handle }, db);
      if (!res.ok) {
        const why =
          res.reason === "unknown-message"
            ? `no message #${id}`
            : res.reason === "own-message"
              ? `message #${id} is your own`
              : `you are not a member of the room message #${id} is in`;
        return { ok: false, error: why };
      }
      // Only a first ack owes a receipt: a repeat is already recorded, and
      // re-waking the author is exactly the noise this verb exists to avoid.
      if (!res.already) {
        const { author, body } = res;
        queueMicrotask(() => {
          deliverAck(db, inboxDeps, log, { author, acker: handle, messageId: id, body }).catch((err) => {
            log.warn({ err, id, handle }, "chat: ack delivery failed");
          });
        });
      }
      return { ok: true, data: { author: res.author, room: res.room, already: res.already } };
    },

    "chat:claim": async (rawPayload: unknown): Promise<CommandResult<"chat:claim">> => {
      const payload = rawPayload as Commands["chat:claim"]["payload"];
      const { id, handle } = payload;
      if (!isValidChatName(handle)) return { ok: false, error: `invalid handle "${handle}"` };
      if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "id must be a positive message id" };
      const res = claimMessage({ messageId: id, handle }, db);
      if (!res.ok) {
        const why = {
          "unknown-message": `no message #${id}`,
          "own-message": `message #${id} is your own`,
          "not-a-member": `you are not a member of the room message #${id} is in`,
          dm: `message #${id} is a DM; nobody else can answer it`,
        }[res.reason];
        return { ok: false, error: why };
      }
      if (res.outcome === "lost") {
        return { ok: true, data: { outcome: "lost", holder: res.holder, claimedAt: res.claimedAt, expiresAt: res.expiresAt } };
      }
      if (res.outcome === "held") return { ok: true, data: { outcome: "held", author: res.author, room: res.room } };
      const { author, room, body, previousHolder } = res;
      queueMicrotask(() => {
        deliverClaim(db, inboxDeps, log, { author, claimer: handle, messageId: id, body, previousHolder }).catch((err) => {
          log.warn({ err, id, handle }, "chat: claim delivery failed");
        });
      });
      return { ok: true, data: previousHolder ? { outcome: "claimed", author, room, previousHolder } : { outcome: "claimed", author, room } };
    },

    "chat:release": async (rawPayload: unknown): Promise<CommandResult<"chat:release">> => {
      const payload = rawPayload as Commands["chat:release"]["payload"];
      const { id, handle } = payload;
      if (!isValidChatName(handle)) return { ok: false, error: `invalid handle "${handle}"` };
      if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "id must be a positive message id" };
      const res = releaseClaim({ messageId: id, handle }, db);
      if (!res.ok) {
        const why = {
          "unknown-message": `no message #${id}`,
          "not-claimed": `#${id} is not claimed`,
          "not-holder": `you are neither the holder of #${id} nor its author`,
        }[res.reason];
        return { ok: false, error: why };
      }
      return { ok: true, data: { holder: res.holder } };
    },

    "chat:read": async (rawPayload: unknown): Promise<CommandResult<"chat:read">> => {
      const payload = rawPayload as Commands["chat:read"]["payload"];
      const { handle, room, limit, sinceMs } = payload;
      const rooms = readUnread({ handle, room, limit: clampLimit(limit, 20), sinceMs }, db);
      return { ok: true, data: { rooms } };
    },

    "chat:rooms": async (rawPayload: unknown): Promise<CommandResult<"chat:rooms">> => {
      const payload = rawPayload as Commands["chat:rooms"]["payload"];
      const rooms = listRooms(payload.handle, db, { includeArchived: payload.includeArchived === true }).map((room) => {
        const defaultWake = roomDefaultWake(room.room, db);
        const withDefault = defaultWake ? { ...room, defaultWake } : room;
        const dm = dmParticipants(room.room, db);
        return dm ? { ...withDefault, kind: "dm" as const, participants: dm } : withDefault;
      });
      return { ok: true, data: { rooms } };
    },

    "chat:who": async (rawPayload: unknown): Promise<CommandResult<"chat:who">> => {
      const payload = rawPayload as Commands["chat:who"]["payload"];
      const now = Date.now();
      const th = presenceThresholds();
      const dm = dmParticipants(payload.room, db);
      let rows = listMembers(payload.room, db);
      if (dm) {
        const humanHandle = getSetting<string>("chat.humanHandle").value;
        // The silent wake_on=none row dm-store adds for the human is not a
        // DM participant — drop it, unless he's one of the two named ones.
        if (humanHandle !== dm.a && humanHandle !== dm.b) {
          rows = rows.filter((member) => member.handle !== humanHandle);
        }
      }
      // One registry scan for the whole room, reused by every member's status.
      const scoped = snapshotRegistryDeps(registryDeps);
      const members = rows.map((member) => {
        const presence = presenceForHandle(member.handle, db);
        // Status is a presence-only concept now: an unsigned plan-1 member
        // (no presence row, e.g. a chat_members row this task's deletions
        // left behind or a name never signed in) has no session to probe
        // the registry with, so it reads offline rather than guessing from
        // stale membership columns.
        const status: BuddyStatus = presence ? buddyStatus(presence, now, th, scoped) : "offline";
        return { ...member, status };
      });
      return { ok: true, data: { members } };
    },

    "chat:mark": async (rawPayload: unknown): Promise<CommandResult<"chat:mark">> => {
      const payload = rawPayload as Commands["chat:mark"]["payload"];
      markRead(payload.handle, payload.room, db);
      return { ok: true, data: {} };
    },

    "chat:messages": async (rawPayload: unknown): Promise<CommandResult<"chat:messages">> => {
      const payload = rawPayload as Commands["chat:messages"]["payload"];
      const { room, before, limit } = payload;
      const messages = listMessages({ room, before, limit: clampLimit(limit, 50) }, db);
      return { ok: true, data: { messages } };
    },

    "chat:sign-in": async (rawPayload: unknown): Promise<CommandResult<"chat:sign-in">> => {
      const payload = rawPayload as Commands["chat:sign-in"]["payload"];
      const { baseHandle, cwd, repo, branch, pane, statusText, viaPane, room: explicitRoom, noRoom } = payload;
      if (baseHandle !== undefined && !isValidChatName(baseHandle)) return { ok: false, error: `invalid handle "${baseHandle}"` };
      if (explicitRoom !== undefined && !isValidChatName(explicitRoom)) return { ok: false, error: `invalid room "${explicitRoom}"` };

      let sessionId = payload.sessionId;
      let signInCwd = cwd;
      let signInRepo = repo;
      let signInBranch = branch;
      // The room --pane sign-in joins on its own: derived from the TARGET
      // pane's cwd (never the invoking process's, which never resolves one
      // for --pane at all -- see commands/chat.ts's runSignInViaPane) through
      // the SAME identity -> roomForIdentity codec the CLI's own sign-in uses
      // (lib/chat-room.ts), so a pane-signed-in and a normally-signed-in
      // agent for the same repo always land in the same room -- the
      // index-based repoForCwd label below is display-only (presence.repo)
      // and must not double as the room source, since it diverges from
      // roomForIdentity's path-kind rule on every pool-slot worktree. The
      // daemon uses `deriveRoomForCwdAsync`, not the CLI's sync
      // `deriveRoomForCwd`: this runs on the daemon thread, which must never
      // sync-exec (MAT-222). `--room` overrides the derivation outright;
      // `--no-room` skips it, same as a pane with no repo cwd. A derivation
      // failure degrades to no room rather than failing the sign-in --
      // exactly like a joinRoom failure below.
      let derivedRoom: string | null = null;

      if (viaPane) {
        if (!pane) return { ok: false, error: "chat: sign-in --pane requires a pane id" };
        const resolved = await findPaneSessionRetrying(herdr, pane, paneSessionBudgetMs, paneSessionPollMs);
        if (!resolved.ok) return resolved;
        sessionId = resolved.session.sessionId;
        if (signInCwd === undefined) signInCwd = resolved.session.cwd;

        if (signInCwd) {
          if (signInRepo === undefined) signInRepo = repoForCwd(signInCwd, repoIndex()) ?? undefined;
          if (signInBranch === undefined) signInBranch = await branchForCwd(signInCwd, exec);
        }

        if (noRoom) {
          derivedRoom = null;
        } else if (explicitRoom) {
          derivedRoom = explicitRoom;
        } else if (signInCwd) {
          try {
            derivedRoom = await deriveRoomForCwdAsync(signInCwd, exec);
          } catch (err) {
            log.warn({ err, cwd: signInCwd }, "chat: --pane sign-in could not derive a room for this cwd");
            derivedRoom = null;
          }
        }
      }
      if (!sessionId) return { ok: false, error: "chat: sign-in requires a sessionId or --pane" };

      // No explicit baseHandle: prefer a name someone CHOSE for this session
      // (registry nameSource "user": --name at launch, /rename) so chat and
      // SendMessage identities match. Claude Code's auto-derived fallback
      // names (nameSource "derived", chat-c6 style) are not names anyone
      // picked: skip them and let the pool draw a real first name instead.
      let resolvedBase = baseHandle;
      if (resolvedBase === undefined) {
        const binding = inboxDeps.resolve(sessionId);
        if (binding?.name && binding.nameSource === "user" && isValidChatName(binding.name)) resolvedBase = binding.name;
      }

      const data = signIn({ sessionId, baseHandle: resolvedBase, cwd: signInCwd, repo: signInRepo, branch: signInBranch, pane, statusText }, db, registryDeps);
      // R057: signIn now retries a busy write rather than throwing, but still
      // reports undefined once its retry budget is exhausted.
      if (!data) return { ok: false, error: "chat: sign-in failed, database busy" };

      if (derivedRoom) {
        try {
          joinRoom({ room: derivedRoom, handle: data.handle, cwd: signInCwd, pane }, db);
        } catch (err) {
          log.warn({ err, room: derivedRoom, handle: data.handle }, "chat: --pane sign-in could not join the derived room");
          derivedRoom = null;
        }
      }

      const rooms = listRooms(data.handle, db).map((r) => r.room);
      // A non-advancing peek, not readUnread: the welcome is composed BEFORE
      // delivery is attempted, and readUnread's cursor write happens
      // unconditionally at read time -- a failed or unresolvable welcome
      // would then have permanently skipped whatever it "showed". The
      // cursor only actually advances, per room, once deliverWelcomeOnce
      // confirms the frame was sent.
      const peeked = peekUnread({ handle: data.handle, limit: WELCOME_CATCHUP_LIMIT }, db);
      const catchup = peeked.map((r) => ({ room: r.room, lines: r.messages.map((m) => `${m.handle}: ${m.body}`) }));
      const catchupCursors = peeked.map((r) => ({ room: r.room, upToId: r.messages[r.messages.length - 1]!.id }));
      const welcomeContent = wrapCrossSession("rt chat", renderWelcome(data.handle, rooms, catchup));
      const welcomeSessionId = sessionId;
      queueMicrotask(() => {
        deliverWelcome(db, deliveryChains, inboxDeps, welcomeSessionId, data.handle, welcomeContent, catchupCursors).catch((err) => {
          log.warn({ err, handle: data.handle }, "chat: welcome delivery failed");
        });
      });

      return { ok: true, data: { ...data, sessionId, room: derivedRoom } };
    },

    // A missing row is the common case, not a refusal: SessionEnd fires for
    // every session and most never sign in.
    //
    // viaPane resolves `pane` -> sessionId through the same findPaneSession
    // path chat:sign-in --pane uses, so a foreign CLAUDE_CODE_SESSION_ID the
    // caller happens to have inherited never substitutes for the target
    // pane's own session -- that would sign the wrong session out.
    "chat:sign-out": async (rawPayload: unknown): Promise<CommandResult<"chat:sign-out">> => {
      const payload = rawPayload as Commands["chat:sign-out"]["payload"];
      let sessionId = payload.sessionId;
      if (payload.viaPane) {
        if (!payload.pane) return { ok: false, error: "chat: sign-out --pane requires a pane id" };
        const snap = await herdr<{ snapshot: HerdrSnapshot }>("session.snapshot", {});
        if (!snap.ok) return herdrError(snap);
        const resolved = findPaneSession(snap.result.snapshot, payload.pane);
        if (!resolved) return { ok: false, error: `chat: no Claude session found for pane "${payload.pane}"` };
        sessionId = resolved.sessionId;
      }
      if (!sessionId) return { ok: false, error: "chat: sign-out requires a sessionId or --pane" };
      if (!presenceForSession(sessionId, db)) return { ok: true, data: { sessionId } };
      signOut(sessionId, undefined, db);
      return { ok: true, data: { sessionId } };
    },

    "chat:away": async (rawPayload: unknown): Promise<CommandResult<"chat:away">> => {
      const payload = rawPayload as Commands["chat:away"]["payload"];
      const err = assertionError(() => assertSessionSignedIn(payload.sessionId, db));
      if (err) return { ok: false, error: err };
      setAway(payload.sessionId, payload.text, db);
      return { ok: true, data: {} };
    },

    "chat:back": async (rawPayload: unknown): Promise<CommandResult<"chat:back">> => {
      const payload = rawPayload as Commands["chat:back"]["payload"];
      const err = assertionError(() => assertSessionSignedIn(payload.sessionId, db));
      if (err) return { ok: false, error: err };
      setAway(payload.sessionId, null, db);
      return { ok: true, data: {} };
    },

    "chat:buddies": async (): Promise<CommandResult<"chat:buddies">> => {
      return { ok: true, data: { buddies: listBuddies(Date.now(), db, registryDeps) } };
    },

    "chat:dm": async (rawPayload: unknown): Promise<CommandResult<"chat:dm">> => {
      const payload = rawPayload as Commands["chat:dm"]["payload"];
      const { from, to, body, sessionId } = payload;
      if (!isValidChatName(from)) return { ok: false, error: `invalid handle "${from}"` };
      if (!isValidChatName(to)) return { ok: false, error: `invalid handle "${to}"` };
      if (!isValidBody(body)) return { ok: false, error: `body must be a non-empty string under ${MAX_BODY_BYTES} bytes` };
      const err = assertionError(() => assertSessionOwnsHandle(from, sessionId, db));
      if (err) return { ok: false, error: err };
      const humanHandle = getSetting<string>("chat.humanHandle").value;
      if (!isValidChatName(humanHandle)) {
        return { ok: false, error: `chat: chat.humanHandle setting is empty or invalid ("${humanHandle}")` };
      }
      let room: string;
      try {
        ({ room } = dmRoomFor(from, to, humanHandle, db));
      } catch (dmErr) {
        return { ok: false, error: dmErr instanceof Error ? dmErr.message : String(dmErr) };
      }
      // Recipient travels in `mentions`, not the body, so the transcript
      // shows the text as typed and the desk still notifies when `to` is
      // the human.
      const posted = postAndNotify(db, emitEvent, { room, handle: from, body, mentions: [to] }, inboxDeps, herdr, deliveryChains, log, retryDelayMs);
      if (!posted) return { ok: false, error: "chat: dm failed (retry budget exhausted)" };
      return { ok: true, data: { room, id: posted.id, recipients: posted.recipients } };
    },

    "chat:invite": async (rawPayload: unknown): Promise<CommandResult<"chat:invite">> => {
      const payload = rawPayload as Commands["chat:invite"]["payload"];
      const { paneId, room, note, from, callerPane } = payload;
      if (!isValidChatName(room)) return { ok: false, error: `invalid room "${room}"` };
      if (!isValidChatName(from)) return { ok: false, error: `invalid handle "${from}"` };
      return injectIntoPane({ paneId, text: inviteText(room, from, note), callerPane, herdr });
    },

    "chat:archive": async (rawPayload: unknown): Promise<CommandResult<"chat:archive">> => {
      const payload = rawPayload as Commands["chat:archive"]["payload"];
      const { room, handle, archived } = payload;
      if (!isValidChatName(handle)) return { ok: false, error: `invalid handle "${handle}"` };
      if (!isValidChatName(room)) return { ok: false, error: `invalid room "${room}"` };
      if (typeof archived !== "boolean") return { ok: false, error: "archived must be true or false" };
      try {
        return { ok: true, data: archiveRoom(room, archived, db) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    "chat:dm-open": async (rawPayload: unknown): Promise<CommandResult<"chat:dm-open">> => {
      const payload = rawPayload as Commands["chat:dm-open"]["payload"];
      const { from, to, sessionId } = payload;
      if (!isValidChatName(from)) return { ok: false, error: `invalid handle "${from}"` };
      if (!isValidChatName(to)) return { ok: false, error: `invalid handle "${to}"` };
      const err = assertionError(() => assertSessionOwnsHandle(from, sessionId, db));
      if (err) return { ok: false, error: err };
      const humanHandle = getSetting<string>("chat.humanHandle").value;
      if (!isValidChatName(humanHandle)) {
        return { ok: false, error: `chat: chat.humanHandle setting is empty or invalid ("${humanHandle}")` };
      }
      try {
        return { ok: true, data: dmRoomFor(from, to, humanHandle, db) };
      } catch (dmErr) {
        return { ok: false, error: dmErr instanceof Error ? dmErr.message : String(dmErr) };
      }
    },
  };
}
