/**
 * The apply engine — runs the contract-pinned step list, emitting the NDJSON
 * stream `rt setup apply --json` and mattstack.app's Install button both read
 * (docs/superpowers/specs/2026-08-21-rt-setup-contract.md, "rt setup apply").
 */

import { appBundlePath } from "../deps/resolve.ts";
import type { SecretsSeams } from "../secrets/store.ts";
import { listTeams } from "../settings/stores.ts";
import type { RelayClient } from "../team/relay-client.ts";
import type { NeedRequest, StepId, StepKind, TeamRef } from "./contract.ts";
import type { Emit } from "./emit.ts";
import { UserActionableError } from "./errors.ts";
import { readIntent, teamRefFromIntent, clearIntent, type SetupIntent } from "./intent.ts";
import { awaitNeed, type NeedReply } from "./need.ts";
import type { Probes } from "./probes.ts";
import { readPackRequirements, type PackRequirements } from "./requirements.ts";
import { STEPS } from "./steps/index.ts";
import { updateSetupState } from "./state.ts";
import { readTeamSnapshot, type TeamSnapshot } from "./team-settings.ts";

export type StepOutcome = { state: "done"; detail?: string } | { state: "skipped"; detail: string } | { state: "failed"; detail: string; remedy?: string };

export interface ApplyContext {
  p: Probes;
  emit: Emit;
  log(id: StepId, line: string): void;
  intent: SetupIntent | null;
  team: TeamRef;
  snapshot: TeamSnapshot | null;
  reqs: PackRequirements[];
  nonInteractive: boolean;
  teamOfOne: boolean;
  appPath: string | null;
  ci: boolean;
  secrets: SecretsSeams;
  relay: RelayClient;
  /** "no-app" is an rt-side judgment (not the app's), made only when nonInteractive AND a quick pre-check finds no live tray.sock — otherwise the real app-gone/timeout dance in `awaitNeed` decides. */
  need(id: StepId, request: NeedRequest): Promise<NeedReply | "timeout" | "app-gone" | "no-app">;
}

export interface StepDef {
  id: StepId;
  title: string;
  kind: StepKind;
  applies(ctx: ApplyContext): boolean;
  run(ctx: ApplyContext): Promise<StepOutcome>;
}

function stepEventFields(outcome: StepOutcome): { detail?: string; remedy?: string } {
  if (outcome.state === "failed") return { detail: outcome.detail, ...(outcome.remedy !== undefined ? { remedy: outcome.remedy } : {}) };
  return outcome.detail !== undefined ? { detail: outcome.detail } : {};
}

/**
 * A step id absent from the resumed run's own step list (an unknown
 * `--from`, or one gated out by `applies`) resumes from the start rather
 * than silently running nothing — --from names an intent, not a guarantee.
 */
function resumeIndex(steps: StepDef[], from: StepId | undefined): number {
  if (!from) return 0;
  const i = steps.findIndex((s) => s.id === from);
  return i < 0 ? 0 : i;
}

/**
 * Runs an explicit step list against a context — the seam `runApply` closes
 * over `STEPS` for. `plan` lists every step this run will touch, including
 * ones before `--from`, because each of those still gets its own `step`
 * event (skipped, not omitted) — the stream stays self-describing without a
 * reader needing to know the resume point up front.
 */
export async function runApplyWith(steps: StepDef[], ctx: ApplyContext, opts: { from?: StepId } = {}): Promise<{ ok: boolean; failedStep?: StepId }> {
  const applicable = steps.filter((s) => s.applies(ctx));
  ctx.emit({ event: "plan", steps: applicable.map((s) => ({ id: s.id, title: s.title, kind: s.kind })) });

  const start = resumeIndex(applicable, opts.from);
  for (let i = 0; i < start; i++) {
    ctx.emit({ event: "step", id: applicable[i]!.id, state: "skipped", detail: "before --from" });
  }

  for (let i = start; i < applicable.length; i++) {
    const step = applicable[i]!;
    ctx.emit({ event: "step", id: step.id, state: "running" });

    let outcome: StepOutcome;
    try {
      outcome = await step.run(ctx);
    } catch (err) {
      if (err instanceof UserActionableError) {
        const remedy = typeof err.extra.remedy === "string" ? err.extra.remedy : undefined;
        outcome = { state: "failed", detail: err.message, ...(remedy !== undefined ? { remedy } : {}) };
      } else {
        // A bug, not a user-actionable failure: report it on the stream as
        // any other failed step, but rethrow so the process crashes (exit 1)
        // instead of exiting cleanly at 2 like a real setup problem would.
        const message = err instanceof Error ? err.message : String(err);
        ctx.emit({ event: "step", id: step.id, state: "failed", detail: `bug: ${message}` });
        ctx.emit({ event: "done", ok: false, failedStep: step.id });
        throw err;
      }
    }

    ctx.emit({ event: "step", id: step.id, state: outcome.state, ...stepEventFields(outcome) });

    if (outcome.state === "failed") {
      ctx.emit({ event: "done", ok: false, failedStep: step.id });
      return { ok: false, failedStep: step.id };
    }
    // "skipped" is non-fatal by contract (a fresh machine skips
    // skills.materialize honestly before plugins.install runs it for real)
    // — only "failed" stops the run.
  }

  updateSetupState(ctx.p, (s) => ({ ...s, lastApplyAt: ctx.p.now().toISOString() }));
  clearIntent(ctx.p);
  ctx.emit({ event: "done", ok: true });
  return { ok: true };
}

export async function runApply(ctx: ApplyContext, opts: { from?: StepId } = {}): Promise<{ ok: boolean; failedStep?: StepId }> {
  return runApplyWith(STEPS, ctx, opts);
}

export interface CreateApplyContextDeps {
  probes: Probes;
  emit: Emit;
  secrets: SecretsSeams;
  relay: RelayClient;
  flags: { nonInteractive: boolean; teamOfOne: boolean; ci: boolean };
}

/** Cheap tray reachability probe, distinct from the polling `awaitNeed` does — an id that has never been requested reads as `pending` (200) just like a real one, so this checks a path no `need` id will ever use. */
async function trayReachable(p: Probes): Promise<boolean> {
  const res = await p.tray("/version", { method: "GET" });
  return res.status !== 0;
}

export async function createApplyContext(deps: CreateApplyContextDeps): Promise<ApplyContext> {
  const { probes: p, emit, secrets, relay, flags } = deps;

  const intent = readIntent(p);
  const team = teamRefFromIntent(intent, listTeams());
  const snapshot = team.slug ? readTeamSnapshot(p, team.slug) : null;
  const reqs = team.slug ? readPackRequirements(p, team.slug) : [];
  const appPath = appBundlePath(p);

  return {
    p,
    emit,
    log(id, line) {
      emit({ event: "log", id, line });
    },
    intent,
    team,
    snapshot,
    reqs,
    nonInteractive: flags.nonInteractive,
    teamOfOne: flags.teamOfOne,
    appPath,
    ci: flags.ci,
    secrets,
    relay,
    async need(id: StepId, request: NeedRequest): Promise<NeedReply | "timeout" | "app-gone" | "no-app"> {
      emit({ event: "need", id, request });
      if (flags.nonInteractive && !(await trayReachable(p))) return "no-app";
      return awaitNeed(p.tray, id);
    },
  };
}

