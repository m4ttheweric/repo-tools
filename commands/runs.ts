/**
 * rt runs — read-only pipeline run state (SKILLS-28).
 *   rt runs [--repo R] [--json]           list, newest first
 *   rt runs show <runId> [--repo R] [--json]
 * All data comes from the daemon's runs:* commands; rt never opens run DBs
 * from the CLI (single reader contract).
 */
import { daemonQuery } from "../lib/daemon-client.ts";
import { resolveRepoArg } from "../lib/repo-arg.ts";
import { repoLabel } from "../lib/repo-label.ts";
import type { RunDetail, RunSummary } from "../packages/rt-client/src/commands.ts";

function fail(msg: string): never {
  console.error(`rt runs: ${msg}`);
  process.exit(1);
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  // Dangling flag (nothing after it, or the next token is itself a flag)
  // must fail loudly -- silently falling back to "no value" here would
  // turn `rt runs --repo` into an unscoped list instead of an error.
  if (v === undefined || v.startsWith("--")) fail(`${flag} requires a value`);
  return v;
}

// Index-based scan (not value comparison — a positional that EQUALS a flag's
// value, e.g. `rt runs show abc --repo abc`, must still parse).
const FLAGS_WITH_VALUES = new Set(["--repo", "--reason"]);
function positional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (FLAGS_WITH_VALUES.has(a)) i++; // skip the flag's value slot
      continue;
    }
    return a;
  }
  return undefined;
}

const STATUS_ICON: Record<string, string> = { running: "●", done: "✓", failed: "✗", abandoned: "○" };

export function formatRunLine(r: RunSummary): string {
  const icon = STATUS_ICON[r.status] ?? "?";
  const stage = r.status === "running" && r.current_stage ? `@ ${r.current_stage}` : "";
  const when = new Date(r.started_at).toISOString().slice(0, 16).replace("T", " ");
  return `${icon} ${r.id}  ${repoLabel(r.repo)}  ${r.work_type}  ${r.status} ${stage}  ${when}`;
}

export function formatRunDetail(d: RunDetail): string {
  const lines: string[] = [formatRunLine(d.run)];
  if (d.schemaAhead) lines.push("(newer schema than this rt knows; some data may be missing)");
  lines.push("", "stages:");
  for (const s of d.stages) {
    lines.push(`  ${STATUS_ICON[s.status] ?? "?"} ${s.name} (attempt ${s.attempt})`);
    if (s.reason) lines.push(`      reason: ${s.reason}`);
    if (s.detail_path) lines.push(`      detail: ${s.detail_path}`);
  }
  lines.push("", "fields:");
  for (const f of d.fields) lines.push(`  ${f.key} = ${f.value}  [${f.produced_by}]`);
  lines.push("", "decisions:");
  for (const dec of d.decisions) lines.push(`  ${dec.contract} ${dec.scope}: ${dec.selection}  [${dec.decided_by}]`);
  return lines.join("\n");
}

class UnresolvedRepoArg extends Error {}

/**
 * Runs are keyed by their on-disk run-dir name: a serialized identity for
 * runs written after the cutover, but whatever key its pipeline used for a
 * run written before it. Resolve `--repo` like every other command when the
 * arg matches a known repo, and otherwise forward it verbatim as a dir key —
 * failing here would make `rt runs --repo <key>` reject exactly the keys
 * `rt runs` itself prints for pre-cutover runs.
 */
async function resolveRunsRepoArg(arg: string): Promise<string> {
  try {
    return await resolveRepoArg(arg, (msg): never => {
      throw new UnresolvedRepoArg(msg);
    });
  } catch (err) {
    if (err instanceof UnresolvedRepoArg) return arg;
    throw err;
  }
}

async function fetchRunsForPicker(args: string[]): Promise<RunSummary[]> {
  const repoArg = flagValue(args, "--repo");
  const repo = repoArg ? await resolveRunsRepoArg(repoArg) : undefined;
  const res = await daemonQuery("runs:list", { repo }, 10_000);
  if (!res || !res.ok) return [];
  return (res.data as { runs: RunSummary[] }).runs;
}

async function pickRunId(runs: RunSummary[], message: string): Promise<string | null> {
  const { filterableSelect } = await import("../lib/rt-render.ts");
  const idWidth = Math.max(...runs.map((r) => r.id.length));
  const options = runs.map((r) => ({
    value: r.id,
    label: r.id.padEnd(idWidth),
    hint: `${repoLabel(r.repo)}  ${r.status}${r.current_stage ? ` @ ${r.current_stage}` : ""}`,
  }));
  return filterableSelect({ message, options, stderr: true });
}

export async function runsList(args: string[]): Promise<void> {
  const repoArg = flagValue(args, "--repo");
  const repo = repoArg ? await resolveRunsRepoArg(repoArg) : undefined;
  const res = await daemonQuery("runs:list", { repo }, 10_000);
  if (!res) fail("daemon unavailable — the run DB needs the rt daemon (rt daemon start)");
  if (!res.ok) fail(res.error ?? "list failed");
  const data = res.data as { runs: RunSummary[] };
  if (args.includes("--json")) { console.log(JSON.stringify(data)); return; }
  if (data.runs.length === 0) { console.log("no runs"); return; }
  for (const r of data.runs) console.log(formatRunLine(r));
}

export async function runsShow(args: string[]): Promise<void> {
  let runId = positional(args);
  const json = args.includes("--json");
  if (!runId) {
    const runs = process.stdin.isTTY && !json && !process.env.RT_BATCH
      ? await fetchRunsForPicker(args)
      : [];
    if (runs.length === 0) fail("usage: rt runs show <runId> [--repo <name>] [--json]");
    const picked = await pickRunId(runs, "pick a run to show");
    if (!picked) process.exit(0);
    runId = picked;
  }
  const repoArg = flagValue(args, "--repo");
  const repo = repoArg ? await resolveRunsRepoArg(repoArg) : undefined;
  const res = await daemonQuery("runs:get", { runId, repo }, 10_000);
  if (!res) fail("daemon unavailable — the run DB needs the rt daemon (rt daemon start)");
  if (!res.ok) fail(res.error ?? "get failed");
  const data = res.data as RunDetail;
  if (args.includes("--json")) { console.log(JSON.stringify(data)); return; }
  console.log(formatRunDetail(data));
}

export async function runsAbandon(args: string[]): Promise<void> {
  let runId = positional(args);
  const json = args.includes("--json");
  if (!runId) {
    const runs = process.stdin.isTTY && !json && !process.env.RT_BATCH
      ? await fetchRunsForPicker(args)
      : [];
    const targets = runs.filter((r) => r.status === "running");
    const pick = targets.length > 0 ? targets : runs;
    if (pick.length === 0) fail("abandon needs a run id");
    const picked = await pickRunId(pick, "pick a run to abandon");
    if (!picked) process.exit(0);
    runId = picked;
  }
  const repoArg = flagValue(args, "--repo");
  const repo = repoArg ? await resolveRunsRepoArg(repoArg) : undefined;
  const reason = flagValue(args, "--reason") ?? "reconciled by hand";
  const res = await daemonQuery("runs:abandon", { runId, repo, reason });
  if (!res) fail("daemon unavailable — the run DB needs the rt daemon (rt daemon start)");
  if (!res.ok) fail(res.error ?? "abandon failed");
  console.log(`abandoned ${runId}`);
}
