/**
 * `team.create` / `team.join` — thin StepDef wrappers over the T16/T18 team
 * library (lib/team/create.ts, publish.ts, join.ts): every git/relay/forge
 * call lives there, never reimplemented or shelled out to the `rt team` CLI
 * here.
 */

import { createTeam, type CreateTeamOpts } from "../../team/create.ts";
import { forgeLogin } from "../../team/forge.ts";
import { joinRedeem, realJoinRedeemSeams } from "../../team/join.ts";
import { publishTeam } from "../../team/publish.ts";
import { createRealTeamSecretsSeams } from "../../secrets/team-store.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";
import { UserActionableError } from "../errors.ts";

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

async function teamCreateRun(ctx: ApplyContext): Promise<StepOutcome> {
  const opts = await resolveCreateOpts(ctx);
  if (opts === "no-remote-source") {
    return { state: "skipped", detail: "no git remote available (set RT_TEAM_REMOTE or run gh auth login)" };
  }

  let created;
  try {
    created = await createTeam(ctx.p, opts, ctx.secrets.ageKeySeam);
  } catch (err) {
    if (err instanceof UserActionableError) return { state: "failed", detail: err.message };
    throw err;
  }

  try {
    const published = await publishTeam(ctx.p, created.slug, null);
    return { state: "done", detail: published.detail };
  } catch (err) {
    if (err instanceof UserActionableError) {
      const remedy = err.code === "push-denied" ? "Check your push access to the team repo, then Retry" : undefined;
      return { state: "failed", detail: err.message, ...(remedy !== undefined ? { remedy } : {}) };
    }
    throw err;
  }
}

async function teamJoinRun(ctx: ApplyContext): Promise<StepOutcome> {
  // realJoinRedeemSeams()'s ageKeySeam is overridden with ctx.secrets.ageKeySeam
  // — the one already threaded through the whole apply run (and what tests
  // fake) — so join's own key exchange never reaches for a second,
  // independently-real keychain seam.
  const seams = { ...realJoinRedeemSeams(), ageKeySeam: ctx.secrets.ageKeySeam };
  const result = await joinRedeem(ctx.p, ctx.relay, createRealTeamSecretsSeams, {}, seams);

  if (result.access === "ok") return { state: "done", detail: result.message };
  if (result.access === "denied") {
    return { state: "failed", detail: result.message, remedy: "Ask the owner to grant access, then Retry" };
  }
  return { state: "failed", detail: result.message, remedy: "Check your network, then Retry" };
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
