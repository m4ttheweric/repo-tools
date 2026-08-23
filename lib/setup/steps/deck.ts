/**
 * `deck.managed` — hands board and gitq to deck's process supervision.
 *
 * board went through mattstack.app's own bootstrap under a legacy name
 * ("mrs") before deck existed, so it is ADOPTED into deck under its real
 * name rather than added fresh: `deck adopt mrs --as board --json` is
 * idempotent (exit 0 covers both "just adopted" and "already adopted"), and
 * the record is then repointed at board's real bundled binary — deck's own
 * `/api/v1/apps/board` PATCH, not another CLI call. A machine that never ran
 * the pre-deck bootstrap has no "mrs" at all (deck answers "unknown app") —
 * that is the fresh-install norm, not a failure, so the board leg skips
 * honestly and the step still completes. gitq has no legacy process to
 * adopt and no working `deck add` wiring yet (MAT-384 — the real CLI parses
 * neither `--managed-by` nor `--host`, and answers the frozen "name taken"
 * on a repeat, not `/already/`), so that leg only ever skips or logs,
 * never fails the run over a known stub.
 *
 * The gate for even attempting any of this — for BOTH tools — is whether
 * they are BUNDLED (`bundledToolPath`, not `resolveTool().chosen`: a PATH
 * copy would still pass `.chosen`, but deck would then be handed a command
 * outside its own bundle to supervise), the same check `need.ts`'s
 * `servicePlists` makes for deck itself.
 */

import { join } from "path";
import { bundledToolPath } from "../../deps/resolve.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";
import { toFailedOutcome } from "./step-utils.ts";

interface DeckApiFile {
  port?: unknown;
}

/** Exported for `lib/setup/uninstall.ts`'s deck.managed-remove, which needs the same "is deck actually up" check before asking it to unmanage anything. */
export function readDeckApiPort(ctx: ApplyContext): number | null {
  const raw = ctx.p.readFile(join(ctx.p.home, ".mattstack", "deck", "api.json"));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as DeckApiFile;
    return typeof parsed.port === "number" ? parsed.port : null;
  } catch {
    return null;
  }
}

export async function deckIsHealthy(ctx: ApplyContext, port: number): Promise<boolean> {
  const res = await ctx.p.fetch(`http://127.0.0.1:${port}/healthz`);
  return res.status === 200;
}

/** deck's own frozen error vocabulary for `adopt` — matched as substrings since the real CLI wraps them in a sentence, not a bare code. */
const FROZEN_ADOPT_ERRORS = ["unknown app", "deck not running", "name taken"] as const;

function matchFrozenError(text: string): (typeof FROZEN_ADOPT_ERRORS)[number] | null {
  return FROZEN_ADOPT_ERRORS.find((needle) => text.includes(needle)) ?? null;
}

type AdoptResult = { kind: "adopted" } | { kind: "skip"; detail: string } | { kind: "failed"; outcome: StepOutcome };

async function adoptBoard(ctx: ApplyContext, deckBin: string): Promise<AdoptResult> {
  const result = await ctx.p.exec([deckBin, "adopt", "mrs", "--as", "board", "--json"]);
  if (result.code === 0) return { kind: "adopted" }; // adopted, or already adopted

  const frozen = matchFrozenError(`${result.stdout}\n${result.stderr}`);

  // "unknown app" means deck has never heard of a legacy "mrs" — true of
  // every fresh install, since none of them ran the pre-deck bootstrap.
  // There is nothing to adopt, not a failed adopt.
  if (frozen === "unknown app") return { kind: "skip", detail: "no legacy mrs to adopt" };

  if (frozen === "deck not running") {
    // A precondition, not a rejection of the adopt itself — deck answered
    // /healthz a moment ago and stopped between then and this exec.
    return { kind: "failed", outcome: { state: "failed", detail: "deck stopped responding before it could adopt board", remedy: "Start deck, then Retry" } };
  }
  return { kind: "failed", outcome: { state: "failed", detail: frozen ?? (result.stderr.trim() || result.stdout.trim() || `deck adopt exited ${result.code}`), remedy: "Retry" } };
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

/**
 * deck's registrar id for everything mattstack ships. The stored value is
 * "rt"; deck renders it as "mattstack" via its own MANAGER_DISPLAY map, and
 * board already carries this exact id. Passing the display name instead
 * produces an unrecognized registrar whose 409 escape hatch tells the user to
 * run `mattstack uninstall <app>` — a command that does not exist.
 */
const MATTSTACK_REGISTRAR = "rt";

/**
 * Registers a bundled app and claims it for mattstack, in that order.
 *
 * Two calls, not one, because `deck add` never forwards a registrar: it parses
 * only `--port`/`--cmd`/`--dir` (MAT-384) and the API defaults the record to
 * `managedBy: "user"`. A user-owned record is invisible to
 * `deck remove --managed`, which scopes to `managedBy !== "user"` — so an app
 * registered by `add` alone silently survives uninstall. `adopt` is the only
 * verb that sets a registrar, and it is how board became managed.
 *
 * Never throws and never fails the run: a from-scratch install must not wedge
 * on a known-incomplete verb. Duplicate registration answers the frozen
 * "name taken", not a bare `/already/` match.
 */
async function registerManagedApp(ctx: ApplyContext, deckBin: string, name: string, serveArgs: string[] = []): Promise<string> {
  const bin = bundledToolPath(ctx.p, name);
  if (bin === null) {
    ctx.log("deck.managed", `${name}: not bundled — left unmanaged`);
    return `${name} not registered: not bundled`;
  }

  const dir = join(ctx.p.home, ".mattstack", name);
  // deck splits --cmd on whitespace into argv. A helper whose DEFAULT argv is
  // its CLI rather than its server needs the serving subcommand here, or deck
  // supervises a command that prints usage and exits.
  const cmd = [bin, ...serveArgs].join(" ");
  const added = await ctx.p.exec([deckBin, "add", name, "--cmd", cmd, "--dir", dir]);
  const already = matchFrozenError(`${added.stdout}\n${added.stderr}`) === "name taken";
  if (added.code !== 0 && !already) {
    const reason = added.stderr.trim() || added.stdout.trim() || `exit ${added.code}`;
    ctx.log("deck.managed", `${name}: deck add failed — ${reason}`);
    return `${name} not registered: ${reason}`;
  }

  // Idempotent: re-adopting an app this registrar already owns is exit 0.
  const adopted = await ctx.p.exec([deckBin, "adopt", name, "--managed-by", MATTSTACK_REGISTRAR, "--json"]);
  if (adopted.code !== 0) {
    const reason = adopted.stderr.trim() || adopted.stdout.trim() || `exit ${adopted.code}`;
    ctx.log("deck.managed", `${name}: registered but not adopted — ${reason}`);
    return `${name} registered but left unmanaged: ${reason}`;
  }
  return already ? `${name} already registered (managed)` : `${name} registered (managed)`;
}

async function deckManagedRun(ctx: ApplyContext): Promise<StepOutcome> {
  const deckBin = bundledToolPath(ctx.p, "deck");
  if (deckBin === null) return { state: "skipped", detail: "deck not bundled yet" };

  const port = readDeckApiPort(ctx);
  const healthy = port !== null && (await deckIsHealthy(ctx, port));
  if (!healthy) {
    return { state: "failed", detail: "deck is not answering its own /healthz — cannot adopt board safely", remedy: "Start deck, then Retry" };
  }

  const adopted = await adoptBoard(ctx, deckBin);
  if (adopted.kind === "failed") return adopted.outcome;

  const boardDetail = adopted.kind === "skip" ? `board not adopted (${adopted.detail})` : `board adopted (${await repointBoard(ctx, port)})`;
  const gitqDetail = await registerManagedApp(ctx, deckBin, "gitq", ["board"]);
  const consoleDetail = await registerManagedApp(ctx, deckBin, "console");

  return { state: "done", detail: `${boardDetail}; ${gitqDetail}; ${consoleDetail}` };
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
