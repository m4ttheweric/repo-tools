/**
 * `skills.materialize`, `board.keys`, `cron.triage` — three small rt-only
 * steps that share no state, kept in one file because none is big enough to
 * earn its own. Each wraps an existing, already-tested library
 * (`materializeSkills`, `getDef`/`setSetting`, `resolveBoardTriage`/
 * `installCronTrigger`) rather than re-deriving its logic.
 */

import { join } from "path";
import { HELPERS_DIR } from "../../bundle-layout.ts";
import { getKnownRepos } from "../../repo-index.ts";
import { appBundlePath, bundledToolPath, resolveTool } from "../../deps/resolve.ts";
import { getDef, isMigrated } from "../../settings/registry.ts";
import { getSetting } from "../../settings/resolve.ts";
import { setSetting } from "../../settings/write.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";
import { installCronTrigger, resolveBoardTriage, triageTrigger } from "../cron-install.ts";
import { linkBundledSkills } from "../skills-link-bundled.ts";
import { materializeSkills } from "../skills-materialize.ts";
import { forgeLogin } from "../../team/forge.ts";
import { resolveForge } from "./forge-identity.ts";
import { repoBasename } from "./repos.ts";
import { toFailedOutcome, unwritten } from "./step-utils.ts";

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

// ─── skills.link ─────────────────────────────────────────────────────────────

async function skillsLinkRun(ctx: ApplyContext): Promise<StepOutcome> {
  const root = appBundlePath(ctx.p);
  if (!root) return { state: "skipped", detail: "not running from an app bundle" };

  const results = linkBundledSkills({
    skillsRoot: join(root, HELPERS_DIR, "skills"),
    claudeSkillsDir: join(ctx.p.home, ".claude", "skills"),
    isBundled: (app) => bundledToolPath(ctx.p, app) !== null,
  });
  if (results.length === 0) return { state: "skipped", detail: "bundle ships no skills" };

  for (const r of results.filter((x) => x.skipped)) ctx.log("skills.link", `${r.app}: ${r.skipped}`);
  const linked = results.filter((r) => !r.skipped);
  const total = linked.reduce((n, r) => n + r.linked, 0);
  return { state: "done", detail: `linked ${total} skill(s) from ${linked.length} app(s)` };
}

async function skillsLinkRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await skillsLinkRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const skillsLinkStep: StepDef = {
  id: "skills.link",
  title: "Link bundled skills",
  kind: "rt",
  applies: () => true,
  run: skillsLinkRunSafe,
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

/**
 * The joiner's own forge handle, which is both who their board runs as and
 * who agents address in chat. Neither key has a writer anywhere else, and
 * chat.humanHandle's registry default is somebody else's handle, so an
 * unseeded machine is wrong rather than merely unconfigured.
 */
async function seedOwnHandle(ctx: ApplyContext, written: string[]): Promise<void> {
  const wantsChatHandle = writable(ctx, "chat.humanHandle") && unwritten("chat.humanHandle");
  const wantsDefaultMember = writable(ctx, "board.defaultMember") && unwritten("board.defaultMember");
  if (!wantsChatHandle && !wantsDefaultMember) return;

  const forge = await resolveForge(ctx);
  if (!forge) {
    ctx.log("board.keys", "chat.humanHandle/board.defaultMember: no forge connected, left unset");
    return;
  }

  const login = await forgeLogin(ctx.p, forge.provider, forge.host, forge.token);
  if (!login) {
    ctx.log("board.keys", "chat.humanHandle/board.defaultMember: forge login unavailable, left unset");
    return;
  }

  if (wantsChatHandle) {
    setSetting("chat.humanHandle", login, "user");
    written.push("chat.humanHandle");
  }
  if (wantsDefaultMember) {
    setSetting("board.defaultMember", login, "user");
    written.push("board.defaultMember");
  }
}

async function boardKeysRun(ctx: ApplyContext): Promise<StepOutcome> {
  const written: string[] = [];
  const repoNames = trackingRepoNames(ctx);
  const root = getSetting<string[]>("rt.repoRoots").value?.[0];

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

  await seedOwnHandle(ctx, written);

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
  const def = getDef("board.reReview");
  if (!def) return { state: "skipped", detail: "board.reReview not registered" };

  const enabled = getSetting<{ enabled?: boolean }>("board.reReview").value?.enabled === true;
  if (!enabled) return { state: "skipped", detail: "board.reReview disabled" };

  const board = resolveTool(ctx.p, "board").exec;
  const resolution = resolveBoardTriage(ctx.p, getKnownRepos(), board);

  if (resolution.kind === "missing") {
    return { state: "skipped", detail: "board binary not found — resolve it first (`rt deps resolve board`)" };
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
