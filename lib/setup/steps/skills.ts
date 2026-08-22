/**
 * `skills.materialize`, `board.keys`, `cron.triage` — three small rt-only
 * steps that share no state, kept in one file because none is big enough to
 * earn its own. Each wraps an existing, already-tested library
 * (`materializeSkills`, `getDef`/`setSetting`, `resolveBoardTriage`/
 * `installCronTrigger`) rather than re-deriving its logic.
 */

import { join } from "path";
import { getKnownRepos } from "../../repo-index.ts";
import { resolveTool } from "../../deps/resolve.ts";
import { getDef, isMigrated } from "../../settings/registry.ts";
import { getSetting } from "../../settings/resolve.ts";
import { setSetting } from "../../settings/write.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";
import { installCronTrigger, resolveBoardTriage, triageTrigger } from "../cron-install.ts";
import { materializeSkills } from "../skills-materialize.ts";
import { repoBasename } from "./repos.ts";
import { toFailedOutcome } from "./step-utils.ts";

// ─── skills.materialize ──────────────────────────────────────────────────────

async function skillsMaterializeRun(ctx: ApplyContext): Promise<StepOutcome> {
  const result = await materializeSkills(ctx.p, {});
  if (result.skipped) return { state: "skipped", detail: result.reason };

  const failed = result.repos.filter((r) => !r.ok);
  for (const r of failed) ctx.log("skills.materialize", `${r.name}: ${r.detail}`);

  const ok = result.repos.length - failed.length;
  return { state: "done", detail: `materialized ${ok}, failed ${failed.length}` };
}

async function skillsMaterializeRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await skillsMaterializeRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const skillsMaterializeStep: StepDef = {
  id: "skills.materialize",
  title: "Materialize skills",
  kind: "rt",
  applies: () => true,
  run: skillsMaterializeRunSafe,
};

// ─── board.keys ──────────────────────────────────────────────────────────────

/** Registered repo names whose real identity is in the team's tracking list — the same basename correspondence `repos.clone` establishes between a tracking identity and the directory it clones into. */
function trackingRepoNames(ctx: ApplyContext): string[] {
  const bases = new Set((ctx.snapshot?.trackingIdentities ?? []).map(repoBasename));
  return getKnownRepos()
    .filter((r) => r.registered !== false && bases.has(r.repoName))
    .map((r) => r.repoName);
}

/** True only when a key is both registered AND write-eligible — a def missing from the registry (or shipped `migrated: false`) is logged and left alone rather than letting `setSetting`'s own refusal crash the step. */
function writable(ctx: ApplyContext, key: string): boolean {
  const def = getDef(key);
  if (!def || !isMigrated(def)) {
    ctx.log("board.keys", `${key}: key not in registry yet`);
    return false;
  }
  return true;
}

function isUnset(key: string): boolean {
  return getSetting(key).value === undefined;
}

function sameArray(a: string[], b: unknown): boolean {
  return Array.isArray(b) && b.length === a.length && b.every((v, i) => v === a[i]);
}

async function boardKeysRun(ctx: ApplyContext): Promise<StepOutcome> {
  const written: string[] = [];
  const repoNames = trackingRepoNames(ctx);
  const root = getSetting<string[]>("rt.repoRoots").value?.[0];

  if (writable(ctx, "board.rtRepos") && !sameArray(repoNames, getSetting<string[]>("board.rtRepos").value)) {
    setSetting("board.rtRepos", repoNames, "machine");
    written.push("board.rtRepos");
  }

  if (writable(ctx, "board.cwds") && isUnset("board.cwds")) {
    if (root && repoNames[0]) {
      const cwd = join(root, repoNames[0]);
      setSetting("board.cwds", { review: cwd, respond: cwd, doctor: cwd }, "machine");
      written.push("board.cwds");
    } else {
      ctx.log("board.keys", "board.cwds: no repo root or registered tracked repo yet — left unset");
    }
  }

  if (writable(ctx, "gitq.board") && isUnset("gitq.board")) {
    setSetting("gitq.board", { repos: repoNames, port: 11008 }, "machine");
    written.push("gitq.board");
  }

  if (writable(ctx, "gitq.workSlots") && isUnset("gitq.workSlots")) {
    if (root) {
      setSetting("gitq.workSlots", { workSlotLocation: join(root, ".gitq-slots"), maxWorkSlots: 3 }, "machine");
      written.push("gitq.workSlots");
    } else {
      ctx.log("board.keys", "gitq.workSlots: no repo root yet — left unset");
    }
  }

  return { state: "done", detail: written.length > 0 ? `wrote: ${written.join(", ")}` : "nothing to write" };
}

async function boardKeysRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await boardKeysRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const boardKeysStep: StepDef = {
  id: "board.keys",
  title: "Generate board keys",
  kind: "rt",
  applies: () => true,
  run: boardKeysRunSafe,
};

// ─── cron.triage ─────────────────────────────────────────────────────────────

async function cronTriageRun(ctx: ApplyContext): Promise<StepOutcome> {
  const def = getDef("board.triage");
  if (!def) return { state: "skipped", detail: "board.triage not registered" };

  const enabled = getSetting<{ enabled?: boolean }>("board.triage").value?.enabled === true;
  if (!enabled) return { state: "skipped", detail: "board.triage not enabled" };

  const board = resolveTool(ctx.p, "board").chosen;
  const resolution = resolveBoardTriage(ctx.p, getKnownRepos(), board);

  if (resolution.kind === "missing") {
    return { state: "skipped", detail: "board binary not found — resolve it first (`rt deps resolve board`)" };
  }
  if (resolution.kind === "unavailable") {
    // The compiled board binary has no triage subcommand — wiring this
    // trigger against it would boot board's HTTP server on every event
    // instead of running one triage pass.
    return {
      state: "skipped",
      detail: "triage isn't available on this install — the board binary has no triage subcommand yet; register a board checkout instead (`rt repos register <path-to-board>`)",
    };
  }

  installCronTrigger(triageTrigger(resolution.run));
  return { state: "done", detail: "installed board-triage" };
}

async function cronTriageRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await cronTriageRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const cronTriageStep: StepDef = {
  id: "cron.triage",
  title: "Install triage cron",
  kind: "rt",
  applies: () => true,
  run: cronTriageRunSafe,
};
