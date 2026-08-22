/**
 * `deck.managed` — hands board and gitq to deck's process supervision.
 *
 * board went through mattstack.app's own bootstrap under a legacy name
 * ("mrs") before deck existed, so it is ADOPTED into deck under its real
 * name rather than added fresh: `deck adopt mrs --as board --json` is
 * idempotent (exit 0 covers both "just adopted" and "already adopted"), and
 * the record is then repointed at board's real bundled binary — deck's own
 * `/api/v1/apps/board` PATCH, not another CLI call. gitq has no such legacy
 * process to adopt, so it goes through deck's ordinary `add`.
 *
 * The gate for even attempting any of this is whether deck is BUNDLED
 * (`bundledToolPath`, not `resolveTool().chosen` — a PATH copy would still
 * pass `.chosen` but has no LaunchAgent behind it for the app to have
 * started), the same check `need.ts`'s `servicePlists` makes for the same
 * reason.
 */

import { join } from "path";
import { bundledToolPath, resolveTool } from "../../deps/resolve.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";
import { toFailedOutcome } from "./step-utils.ts";

interface DeckApiFile {
  port?: unknown;
}

function readDeckApiPort(ctx: ApplyContext): number | null {
  const raw = ctx.p.readFile(join(ctx.p.home, ".mattstack", "deck", "api.json"));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as DeckApiFile;
    return typeof parsed.port === "number" ? parsed.port : null;
  } catch {
    return null;
  }
}

async function deckIsHealthy(ctx: ApplyContext, port: number): Promise<boolean> {
  const res = await ctx.p.fetch(`http://127.0.0.1:${port}/healthz`);
  return res.status === 200;
}

/** deck's own frozen error vocabulary for `adopt` — matched as substrings since the real CLI wraps them in a sentence, not a bare code. */
const FROZEN_ADOPT_ERRORS = ["deck not running", "unknown app", "name taken"] as const;

function matchFrozenError(text: string): (typeof FROZEN_ADOPT_ERRORS)[number] | null {
  return FROZEN_ADOPT_ERRORS.find((needle) => text.includes(needle)) ?? null;
}

async function adoptBoard(ctx: ApplyContext, deckBin: string): Promise<StepOutcome | null> {
  const result = await ctx.p.exec([deckBin, "adopt", "mrs", "--as", "board", "--json"]);
  if (result.code === 0) return null; // adopted, or already adopted — proceed

  const frozen = matchFrozenError(`${result.stdout}\n${result.stderr}`);
  if (frozen === "deck not running") {
    // A precondition, not a rejection of the adopt itself — deck answered
    // /healthz a moment ago and stopped between then and this exec.
    return { state: "failed", detail: "deck stopped responding before it could adopt board", remedy: "Start deck, then Retry" };
  }
  return { state: "failed", detail: frozen ?? (result.stderr.trim() || result.stdout.trim() || `deck adopt exited ${result.code}`), remedy: "Retry" };
}

/** Idempotent: repointing at the same command/workingDirectory a second time is just another PATCH deck accepts. Skips honestly, never pointing the record at a binary that doesn't exist, when board isn't bundled yet. */
async function repointBoard(ctx: ApplyContext, port: number): Promise<string> {
  const boardBin = bundledToolPath(ctx.p, "board");
  if (boardBin === null) return "repoint skipped (board not bundled yet)";

  const body = JSON.stringify({ command: [boardBin], workingDirectory: join(ctx.p.home, ".mattstack", "board") });
  const res = await ctx.p.fetch(`http://127.0.0.1:${port}/api/v1/apps/board`, { method: "PATCH", headers: { "content-type": "application/json" }, body });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`deck answered ${res.status} repointing board's record`);
  }
  return "repointed";
}

async function registerGitq(ctx: ApplyContext, deckBin: string): Promise<string> {
  const bin = resolveTool(ctx.p, "gitq").chosen;
  if (bin === null) {
    ctx.log("deck.managed", "gitq: no binary resolved — left unmanaged");
    return "gitq: no binary";
  }

  const result = await ctx.p.exec([deckBin, "add", "gitq", "--cmd", bin, "--managed-by", "mattstack", "--host", "gitq.mattstack"]);
  const ok = result.code === 0 || `${result.stdout}${result.stderr}`.includes("already");
  if (!ok) throw new Error(`deck add gitq failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  return "gitq registered";
}

async function deckManagedRun(ctx: ApplyContext): Promise<StepOutcome> {
  const deckBin = bundledToolPath(ctx.p, "deck");
  if (deckBin === null) return { state: "skipped", detail: "deck not bundled yet" };

  const port = readDeckApiPort(ctx);
  const healthy = port !== null && (await deckIsHealthy(ctx, port));
  if (!healthy) {
    return { state: "failed", detail: "deck is not answering its own /healthz — cannot adopt board safely", remedy: "Start deck, then Retry" };
  }

  const adoptFailure = await adoptBoard(ctx, deckBin);
  if (adoptFailure) return adoptFailure;

  const repointDetail = await repointBoard(ctx, port);
  const gitqDetail = await registerGitq(ctx, deckBin);

  return { state: "done", detail: `board adopted (${repointDetail}); ${gitqDetail}` };
}

async function deckManagedRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await deckManagedRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const deckManagedStep: StepDef = {
  id: "deck.managed",
  title: "Set up managed deck",
  kind: "rt",
  applies: () => true,
  run: deckManagedRunSafe,
};
