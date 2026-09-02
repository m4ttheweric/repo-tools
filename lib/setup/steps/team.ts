/**
 * `team.create` / `team.join` — thin StepDef wrappers over the T16/T18 team
 * library (lib/team/create.ts, publish.ts, join.ts): every git/relay/forge
 * call lives there, never reimplemented or shelled out to the `rt team` CLI
 * here.
 */

import { createTeam, type CreateTeamOpts } from "../../team/create.ts";
import { forgeLogin } from "../../team/forge.ts";
import { JoinKeyExchangeError, joinRedeem, realJoinRedeemSeams } from "../../team/join.ts";
import { forgeTokenKey } from "../../team/git-credential.ts";
import { publishTeam } from "../../team/publish.ts";
import { NoAgeKeyError, readSecret } from "../../secrets/store.ts";
import { readStagedSecret } from "../staging.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";
import { UserActionableError } from "../errors.ts";
import { readIntent } from "../intent.ts";
import { toFailedOutcome } from "./step-utils.ts";

/**
 * Resolves this run's create opts from whichever source triggered
 * `applies()`: an explicit `intent.mode === "create"` carries its own
 * name/remote/others already, resolved earlier by `rt team create`; the
 * team-of-one headless path has neither, so it falls back to
 * RT_TEAM_NAME/RT_TEAM_REMOTE and a `gh`-derived repo owner. Returns null for
 * the one case that must never reach `createTeam` at all — team-of-one with
 * no remote source — so the caller can report an honest skip instead of
 * `createTeam` throwing `remote-required` (that error is a real failure only
 * when an intent explicitly asked for create).
 */
async function resolveCreateOpts(ctx: ApplyContext): Promise<CreateTeamOpts | "no-remote-source"> {
  const { p } = ctx;
  const intentTeam = ctx.intent?.mode === "create" ? ctx.intent.team : undefined;

  if (intentTeam) {
    const createRepoOwner = intentTeam.remote ? undefined : ((await forgeLogin(p, "github", "github.com")) ?? undefined);
    return { name: intentTeam.name, remote: intentTeam.remote || null, createRepoOwner, others: intentTeam.others };
  }

  const envRemote = p.env.RT_TEAM_REMOTE ?? null;
  const createRepoOwner = envRemote ? undefined : ((await forgeLogin(p, "github", "github.com")) ?? undefined);
  if (!envRemote && !createRepoOwner) return "no-remote-source";
  return { name: p.env.RT_TEAM_NAME ?? "personal", remote: envRemote, createRepoOwner, others: false };
}

/** The forge token for `remote`'s host: the sops store when it exists, else what the checklist staged — this step runs before secrets.write drains the stage. Null when rt holds none. */
async function forgeTokenFor(ctx: ApplyContext, remote: string): Promise<string | null> {
  const key = forgeTokenKey(remote);
  if (!key) return null;
  try {
    const stored = await readSecret("rt", key, ctx.secrets);
    if (stored !== null) return stored;
  } catch (err) {
    if (!(err instanceof NoAgeKeyError)) return null;
  }
  return readStagedSecret(ctx.p, "rt", key);
}

async function teamCreateRun(ctx: ApplyContext): Promise<StepOutcome> {
  const opts = await resolveCreateOpts(ctx);
  if (opts === "no-remote-source") {
    return { state: "skipped", detail: "no git remote available (set RT_TEAM_REMOTE or run gh auth login)" };
  }

  let created;
  try {
    created = await createTeam(ctx.p, opts, ctx.secrets.ageKeySeam);
  } catch (err) {
    // createTeam's own git-step failures are all UserActionableError, but its
    // ensureAgeKey call (a keychain/age-keygen subprocess) is not wrapped and
    // can throw a plain Error — that must still become a failed step, not a
    // crash.
    if (err instanceof UserActionableError) return { state: "failed", detail: err.message };
    return toFailedOutcome(err);
  }

  try {
    const published = await publishTeam(ctx.p, created.slug, null, { token: await forgeTokenFor(ctx, created.remote) });
    return { state: "done", detail: published.detail };
  } catch (err) {
    if (err instanceof UserActionableError) {
      const remedy = err.code === "push-denied" ? "Check your push access to the team repo, then Retry" : undefined;
      return { state: "failed", detail: err.message, ...(remedy !== undefined ? { remedy } : {}) };
    }
    return toFailedOutcome(err);
  }
}

/** `no-join-intent` (the real code `joinRedeem` throws for this) only ever means one thing at this point in the run: `applies()` gated this step in from a `ctx.intent` snapshot taken before the run started, and a prior drive of this exact step already redeemed the invite and cleared it — `joinRedeem` clears intent on full success. That is a completed join, not a missing one. */
function noJoinIntentOnDisk(ctx: ApplyContext): boolean {
  const intent = readIntent(ctx.p);
  return intent?.mode !== "join" || !intent.join;
}

async function teamJoinRun(ctx: ApplyContext): Promise<StepOutcome> {
  if (noJoinIntentOnDisk(ctx)) {
    return { state: "skipped", detail: "already joined — no invite in progress" };
  }

  // realJoinRedeemSeams()'s ageKeySeam is overridden with ctx.secrets.ageKeySeam
  // — the one already threaded through the whole apply run (and what tests
  // fake) — so join's own key exchange never reaches for a second,
  // independently-real keychain seam. ctx.teamSecrets is the same discipline
  // for the team-secret (switchboard token) read.
  const seams = { ...realJoinRedeemSeams(), ageKeySeam: ctx.secrets.ageKeySeam, forgeToken: (_p: unknown, remote: string) => forgeTokenFor(ctx, remote) };

  try {
    const result = await joinRedeem(ctx.p, ctx.relay, ctx.teamSecrets, {}, seams);

    if (result.access === "ok") return { state: "done", detail: result.message };
    if (result.access === "denied") {
      return { state: "failed", detail: result.message, remedy: "Ask the owner to grant access, then Retry" };
    }
    return { state: "failed", detail: result.message, remedy: "Check your network, then Retry" };
  } catch (err) {
    // Fires only after the clone and the relay redeem have already
    // succeeded — the invite is spent, so the fix is never "get a new code."
    if (err instanceof JoinKeyExchangeError) {
      return {
        state: "failed",
        detail: err.message,
        remedy: "Unlock your keychain, then Retry — the invite is already redeemed, so Retry resumes here without a new code",
      };
    }
    if (err instanceof UserActionableError) return { state: "failed", detail: err.message };
    return toFailedOutcome(err);
  }
}

export const teamCreateStep: StepDef = {
  id: "team.create",
  title: "Create your team",
  kind: "rt",
  applies: (ctx) => ctx.intent?.mode === "create" || (ctx.teamOfOne && ctx.intent === null && ctx.team.slug === ""),
  run: teamCreateRun,
};

export const teamJoinStep: StepDef = {
  id: "team.join",
  title: "Join your team",
  kind: "rt",
  applies: (ctx) => ctx.intent?.mode === "join",
  run: teamJoinRun,
};
