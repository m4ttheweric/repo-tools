/**
 * rt runs <write verb>: the pipeline's write side of the run DB. Parsing and
 * printing only; every mutation lives in lib/runs/write.ts.
 *   rt runs run-start   --repo R --work-type T --pipeline P [--run-id ID] [--spawned-by S]
 *                       [--pack-dirs "DIR:DIR"] [--ticket ID] [--mattstack-sha SHA]
 *                       [--mattstack-dirty 0|1] [--pack-sha NAME=VALUE]
 *   rt runs run-status  --status done|failed|abandoned
 *   rt runs stage-start --stage NAME
 *   rt runs stage-done  --stage NAME
 *   rt runs stage-fail  --stage NAME [--reason TEXT] [--detail-path PATH]
 *   rt runs field set   KEY VALUE --stage NAME
 *   rt runs field get   KEY
 *   rt runs decision record --contract C --scope S --selection JSON --decided-by W
 *   rt runs snapshot
 * Every verb but run-start reads RT_RUN_DB. Output is JSON on stdout for
 * every outcome except `field get`. Exit 1 sqlite, 2 usage or environment,
 * 3 not found.
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { emitRunUpdated } from "../lib/runs/emit.ts";
import { runStart } from "../lib/runs/start.ts";
import { runsRoot } from "../lib/runs/store.ts";
import {
  decisionRecord, fieldGet, fieldSet, openRunDb, runIdentity, runStatus, snapshot, stageEnd, stageStart,
  type Fail,
} from "../lib/runs/write.ts";

export type WriteVerb = "run-start" | "run-status" | "stage-start" | "stage-done" | "stage-fail" | "field" | "decision" | "snapshot";
export type CliResult = { out: string; code: number };

class Usage extends Error {
  constructor(message: string) { super(message); }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function fail(f: Fail): CliResult {
  return { out: json({ ok: false, error: f.error }), code: f.code };
}

// A value flag followed by nothing, or by another flag, is a usage error:
// silently taking the next flag as the value is how `--mattstack-dirty`
// once became a sha.
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Usage(`${flag} requires a value`);
  return v;
}

function required(args: string[], flag: string): string {
  const v = flagValue(args, flag);
  if (v === undefined || v === "") throw new Usage(`${flag} is required`);
  return v;
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) { i++; continue; }
    out.push(a);
  }
  return out;
}

async function emitted(env: NodeJS.ProcessEnv, ident: { repo: string; runId: string } | null, stage: string | null, kind: string): Promise<void> {
  if (!ident) return;
  await emitRunUpdated({ repo: ident.repo, runId: ident.runId, stage, kind }, env);
}

export async function runWriteVerb(verb: WriteVerb, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<CliResult> {
  try {
    return await dispatch(verb, args, env);
  } catch (err) {
    if (err instanceof Usage) return { out: json({ ok: false, error: err.message }), code: 2 };
    return { out: json({ ok: false, error: `sqlite write failed: ${String(err)}` }), code: 1 };
  }
}

async function dispatch(verb: WriteVerb, args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  switch (verb) {
    case "run-start": {
      const repo = required(args, "--repo");
      const workType = required(args, "--work-type");
      const pipeline = required(args, "--pipeline");
      const dirty = flagValue(args, "--mattstack-dirty");
      if (dirty !== undefined && dirty !== "0" && dirty !== "1") throw new Usage("--mattstack-dirty must be 0 or 1");
      const packDirs = (flagValue(args, "--pack-dirs") ?? "").split(":").filter((d) => d !== "");
      const r = runStart(env.RT_RUNS_ROOT ?? runsRoot(), {
        repo, workType, pipeline,
        runId: flagValue(args, "--run-id"),
        spawnedBy: flagValue(args, "--spawned-by"),
        packDirs,
        ticket: flagValue(args, "--ticket"),
        mattstackSha: flagValue(args, "--mattstack-sha"),
        mattstackDirty: dirty === "1",
        packSha: flagValue(args, "--pack-sha"),
        env,
      });
      if (!r.ok) return fail(r);
      await emitted(env, { repo, runId: r.runId }, null, "run-start");
      return { out: json({ ok: true, runId: r.runId, runDb: r.runDb }), code: 0 };
    }
    case "run-status": {
      const status = required(args, "--status");
      return withRunDbAsync(env, async (db) => {
        const r = runStatus(db, status);
        if (!r.ok) return fail(r);
        await emitted(env, runIdentity(db), null, "run-status");
        return { out: json({ ok: true }), code: 0 };
      });
    }
    case "stage-start": {
      const stage = required(args, "--stage");
      return withRunDbAsync(env, async (db) => {
        const r = stageStart(db, stage, env);
        if (!r.ok) return fail(r);
        await emitted(env, runIdentity(db), stage, "stage-start");
        return { out: json({ ok: true }), code: 0 };
      });
    }
    case "stage-done":
    case "stage-fail": {
      const stage = required(args, "--stage");
      const reason = flagValue(args, "--reason");
      const detailPath = flagValue(args, "--detail-path");
      return withRunDbAsync(env, async (db) => {
        const r = stageEnd(db, stage, verb === "stage-done" ? "done" : "failed", { reason, detailPath });
        if (!r.ok) return fail(r);
        await emitted(env, runIdentity(db), stage, verb);
        return { out: json({ ok: true }), code: 0 };
      });
    }
    case "field": {
      const [sub, key, value] = positionals(args);
      if (sub === "set") {
        if (!key || value === undefined) throw new Usage("field set needs KEY VALUE");
        const stage = required(args, "--stage");
        return withRunDbAsync(env, async (db) => {
          const r = fieldSet(db, key, value, stage);
          if (!r.ok) return fail(r);
          await emitted(env, runIdentity(db), stage, "field-set");
          return { out: json({ ok: true }), code: 0 };
        });
      }
      if (sub === "get") {
        if (!key) throw new Usage("field get needs KEY");
        return withRunDbAsync(env, async (db) => {
          const r = fieldGet(db, key);
          return r.ok ? { out: r.value, code: 0 } : { out: "", code: 3 };
        });
      }
      throw new Usage("field needs set|get");
    }
    case "decision": {
      const [sub] = positionals(args);
      if (sub !== "record") throw new Usage("decision needs record");
      const o = {
        contract: required(args, "--contract"),
        scope: required(args, "--scope"),
        selection: required(args, "--selection"),
        decidedBy: required(args, "--decided-by"),
      };
      return withRunDbAsync(env, async (db) => {
        const r = decisionRecord(db, o);
        if (!r.ok) return fail(r);
        await emitted(env, runIdentity(db), o.scope, "decision");
        return { out: json({ ok: true }), code: 0 };
      });
    }
    case "snapshot":
      return withRunDbAsync(env, async (db) => {
        const r = snapshot(db);
        return r.ok ? { out: json(r), code: 0 } : fail(r);
      });
  }
}

async function withRunDbAsync(env: NodeJS.ProcessEnv, body: (db: Database) => Promise<CliResult>): Promise<CliResult> {
  const path = env.RT_RUN_DB;
  if (!path) return { out: json({ ok: false, error: "RT_RUN_DB is not set" }), code: 2 };
  if (!existsSync(path)) return { out: json({ ok: false, error: `run DB not found: ${path}` }), code: 2 };
  const db = openRunDb(path);
  try {
    return await body(db);
  } finally {
    db.close();
  }
}

async function finish(result: CliResult): Promise<void> {
  if (result.out !== "") console.log(result.out);
  if (result.code !== 0) process.exit(result.code);
}

export async function runsRunStart(args: string[]): Promise<void> { await finish(await runWriteVerb("run-start", args)); }
export async function runsRunStatus(args: string[]): Promise<void> { await finish(await runWriteVerb("run-status", args)); }
export async function runsStageStart(args: string[]): Promise<void> { await finish(await runWriteVerb("stage-start", args)); }
export async function runsStageDone(args: string[]): Promise<void> { await finish(await runWriteVerb("stage-done", args)); }
export async function runsStageFail(args: string[]): Promise<void> { await finish(await runWriteVerb("stage-fail", args)); }
export async function runsField(args: string[]): Promise<void> { await finish(await runWriteVerb("field", args)); }
export async function runsDecision(args: string[]): Promise<void> { await finish(await runWriteVerb("decision", args)); }
export async function runsSnapshot(args: string[]): Promise<void> { await finish(await runWriteVerb("snapshot", args)); }
