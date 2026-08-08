#!/usr/bin/env bun

/**
 * rt evidence: capture-request lifecycle for screenshot evidence.
 *
 * Usage:
 *   rt evidence request <sandboxId> --case <id> --view <name> --recipe <name>
 *                       --slot before|after|standalone [--arg k=v ...]
 *                       [--local] [--force-before] [--json]
 *   rt evidence ls [--sandbox <id>] [--branch <name>] [--pending] [--json]
 *   rt evidence pull [<requestId>] [--json]
 *   rt evidence fulfill <requestId> <basePng> [annotatedPng] [--json]
 *   rt evidence review [--branch <name>]
 *
 * Exit codes follow rt sandbox: 0 ok / 2 daemon-or-controller failure /
 * 64 usage. The daemon owns the ledger state machine and the sidecar/local-
 * chrome capture split (lib/daemon/handlers/evidence.ts); these verbs are a
 * thin client over its facades (lib/daemon-client.ts).
 *
 * CLUSTER-VERIFY PENDING: the controller's evidence endpoints (POST
 * /sandboxes/:id/evidence, GET .../evidence) are not deployed anywhere yet.
 * The sidecar leg of `request` and the --sandbox merge in `ls` are exercised
 * only by unit tests with injected fakes until the sandbox controller bring-up.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { CommandContext } from "../lib/command-tree.ts";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import { resolveRepoId } from "../lib/validate-farm.ts";
import { createSandboxClient, findSandboxAnchor, type EvidenceSlot } from "../lib/sandbox.ts";
import { probeController } from "./validate.ts";
import {
  evidenceDecide,
  evidenceFulfill,
  evidenceList,
  evidencePull,
  evidenceRedraw,
  evidenceRequest,
} from "../lib/daemon-client.ts";
import type { EvidenceLedgerEntry } from "../lib/daemon/evidence-ledger.ts";
import { navSeparator, runNavPicker, type NavOption } from "../lib/navigate.ts";
import { buildImagePreviewSnippet, shellQuote } from "../lib/nav-fs.ts";
import { redrawAnnotations, type RedrawDeps } from "../lib/evidence-redraw.ts";

// ─── Shared helpers ──────────────────────────────────────────────────────────

function usageExit(message: string): never {
  console.error(`\n  ${red}${message}${reset}\n`);
  process.exit(64);
}

function helpExit(): never {
  console.log(`
  ${bold}rt evidence request${reset} <sandboxId> --case <id> --view <name> --recipe <name> --slot before|after|standalone [--arg k=v ...] [--local] [--force-before] [--json]
      queue an evidence capture; branch resolves from the sandbox anchor (or the worktree with --local)
  ${bold}rt evidence ls${reset} [--sandbox <id>] [--branch <name>] [--pending] [--json]
      ledger entries; --sandbox also merges controller-queued rows the ledger doesn't know about yet
  ${bold}rt evidence pull${reset} [<requestId>] [--json]
      sync captured artifacts into the evidence tree (every captured entry when no id given)
  ${bold}rt evidence fulfill${reset} <requestId> <basePng> [annotatedPng] [--json]
      file a local-chrome capture's screenshot(s), flipping the request to synced
  ${bold}rt evidence review${reset} [--branch <name>]
      interactive picker over synced evidence; ctrl-a approve, ctrl-r reject,
      ctrl-e edit annotations and redraw, enter shows manifest provenance
`);
  process.exit(0);
}

/** Resolve the farm repoId from the worktree's origin, or exit 64. */
function requireRepoId(ctx: CommandContext): string {
  const repoId = resolveRepoId(ctx.identity!.remoteUrl);
  if (!repoId) {
    usageExit(
      `no farm overlay claims this repo's origin: create ~/.rt/repos/<repoId>/repo.jsonc with { "origin": "${ctx.identity!.remoteUrl}" }`,
    );
  }
  return repoId;
}

/** Fail with 2 (infra) when the controller is unreachable. */
async function requireController(): Promise<void> {
  if (!(await probeController())) {
    console.error(`\n  ${red}controller unreachable${reset}`);
    console.error(`  ${dim}is the mattcloud cluster up? (MC_CONTROLLER_URL overrides; the daemon or rt validate can hold port-forwards)${reset}\n`);
    process.exit(2);
  }
}

function infraExit(err: unknown): never {
  console.error(`\n  ${red}evidence pipeline failed${reset}`);
  console.error(`  ${dim}${err instanceof Error ? err.message : String(err)}${reset}\n`);
  process.exit(2);
}

// ─── rt evidence request ─────────────────────────────────────────────────────

export interface EvidenceRequestFlags {
  sandboxId: string | null;
  caseId: string;
  view: string;
  recipe: string;
  slot: EvidenceSlot;
  args: Record<string, string>;
  local: boolean;
  forceBefore: boolean;
  json: boolean;
}

/** Pure flag parser for `rt evidence request`, no process.exit, testable in isolation. */
export function parseEvidenceRequestFlags(args: string[]): EvidenceRequestFlags | { error: string } {
  let sandboxId: string | null = null;
  let caseId: string | null = null;
  let view: string | null = null;
  let recipe: string | null = null;
  let slot: string | null = null;
  const evidenceArgs: Record<string, string> = {};
  let local = false;
  let forceBefore = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--case") caseId = args[++i] ?? null;
    else if (arg === "--view") view = args[++i] ?? null;
    else if (arg === "--recipe") recipe = args[++i] ?? null;
    else if (arg === "--slot") slot = args[++i] ?? null;
    else if (arg === "--arg") {
      const pair = args[++i];
      const eq = pair ? pair.indexOf("=") : -1;
      if (!pair || eq <= 0) return { error: "--arg takes k=v" };
      evidenceArgs[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    else if (arg === "--local") local = true;
    else if (arg === "--force-before") forceBefore = true;
    else if (arg === "--json") json = true;
    else if (arg.startsWith("--")) return { error: `unknown argument: ${arg}` };
    else if (sandboxId === null) sandboxId = arg;
    else return { error: `unexpected argument: ${arg}` };
  }

  if (!sandboxId && !local) return { error: "sandbox id is required (or pass --local)" };
  if (!caseId) return { error: "--case is required" };
  if (!view) return { error: "--view is required" };
  if (!recipe) return { error: "--recipe is required" };
  if (slot !== "before" && slot !== "after" && slot !== "standalone") {
    return { error: "--slot must be before, after, or standalone" };
  }

  return { sandboxId, caseId, view, recipe, slot, args: evidenceArgs, local, forceBefore, json };
}

export async function requestCommand(args: string[], ctx: CommandContext): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) helpExit();
  const parsed = parseEvidenceRequestFlags(args);
  if ("error" in parsed) usageExit(parsed.error);

  const repoId = requireRepoId(ctx);

  let branch: string | null = null;
  if (parsed.sandboxId) {
    branch = findSandboxAnchor(parsed.sandboxId)?.branch ?? null;
    if (!branch) usageExit(`sandbox ${parsed.sandboxId} has no local anchor, branch cannot be resolved`);
  } else {
    try {
      branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
    } catch { /* fall through to the usage error */ }
    if (!branch || branch === "HEAD") usageExit("no sandbox id and HEAD is detached, pass a sandbox id or check out a branch");
  }

  try {
    const out = await evidenceRequest({
      repoId,
      branch,
      ...(parsed.sandboxId ? { sandboxId: parsed.sandboxId } : {}),
      caseId: parsed.caseId,
      view: parsed.view,
      recipe: parsed.recipe,
      ...(Object.keys(parsed.args).length ? { args: parsed.args } : {}),
      slot: parsed.slot,
      ...(parsed.forceBefore ? { forceBefore: true } : {}),
      ...(parsed.local ? { executor: "local-chrome" as const } : {}),
    });
    if (parsed.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`\n  ${green}✓${reset} evidence request ${bold}${out.requestId}${reset} queued`);
      console.log(`  ${dim}executor ${out.executor}${reset}\n`);
    }
  } catch (err) {
    infraExit(err);
  }
}

// ─── rt evidence ls ───────────────────────────────────────────────────────────

interface LsRow {
  branch: string;
  caseId: string;
  view: string;
  recipe: string;
  slot: string;
  state: string;
  requestId: string;
}

const PENDING_STATES = ["requested", "captured", "synced"];

export async function lsCommand(args: string[]): Promise<void> {
  let sandboxId: string | null = null;
  let branch: string | null = null;
  let pending = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") helpExit();
    else if (arg === "--sandbox") { sandboxId = args[++i] ?? null; if (!sandboxId) usageExit("--sandbox requires an id"); }
    else if (arg === "--branch") { branch = args[++i] ?? null; if (!branch) usageExit("--branch requires a name"); }
    else if (arg === "--pending") pending = true;
    else if (arg === "--json") json = true;
    else usageExit(`unknown argument: ${arg}`);
  }

  const filter: { branch?: string; sandboxId?: string; states?: string[] } = {};
  if (branch) filter.branch = branch;
  if (sandboxId) filter.sandboxId = sandboxId;
  if (pending) filter.states = PENDING_STATES;

  let entries: EvidenceLedgerEntry[];
  try {
    entries = await evidenceList(filter);
  } catch (err) {
    infraExit(err);
  }

  const rows: LsRow[] = entries.map((e) => ({
    branch: e.branch, caseId: e.caseId, view: e.view, recipe: e.recipe,
    slot: e.slot, state: e.state, requestId: e.requestId,
  }));

  if (sandboxId) {
    await requireController();
    const known = new Set(entries.map((e) => e.requestId));
    const anchorBranch = findSandboxAnchor(sandboxId)?.branch ?? branch ?? "";
    try {
      const queued = await createSandboxClient().listEvidence(sandboxId);
      for (const q of queued) {
        if (known.has(q.id)) continue;
        rows.push({
          branch: anchorBranch, caseId: q.caseId, view: q.view, recipe: q.recipe,
          slot: q.slot, state: "queued (controller)", requestId: q.id,
        });
      }
    } catch (err) {
      infraExit(err);
    }
  }

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(`\n  ${dim}no evidence requests${reset}\n`);
    return;
  }
  console.log("");
  for (const r of rows) {
    console.log(
      `  ${cyan}${r.branch || "-"}${reset}  ${r.caseId}  ${r.view}  ${r.recipe}  ${r.slot}  ${bold}${r.state}${reset}  ${dim}${r.requestId}${reset}`,
    );
  }
  console.log("");
}

// ─── rt evidence pull ─────────────────────────────────────────────────────────

export async function pullCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const requestId = args.find((a) => !a.startsWith("--"));

  let out: { synced: string[] };
  try {
    out = await evidencePull(requestId);
  } catch (err) {
    infraExit(err);
  }

  if (json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (out.synced.length === 0) {
    console.log(`\n  ${dim}nothing to pull${reset}\n`);
    return;
  }
  console.log(`\n  ${green}✓${reset} synced ${out.synced.length} request${out.synced.length === 1 ? "" : "s"}`);
  for (const id of out.synced) console.log(`  ${dim}${id}${reset}`);
  console.log("");
}

// ─── rt evidence fulfill ──────────────────────────────────────────────────────

export async function fulfillCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("--"));
  const [requestId, basePng, annotatedPng] = positional;
  if (!requestId || !basePng) usageExit("usage: rt evidence fulfill <requestId> <basePng> [annotatedPng]");
  if (!existsSync(basePng)) usageExit(`no such file: ${basePng}`);
  if (annotatedPng && !existsSync(annotatedPng)) usageExit(`no such file: ${annotatedPng}`);

  try {
    await evidenceFulfill(requestId, basePng, annotatedPng);
  } catch (err) {
    infraExit(err);
  }

  if (json) {
    console.log(JSON.stringify({ requestId }, null, 2));
    return;
  }
  console.log(`\n  ${green}✓${reset} evidence ${bold}${requestId}${reset} filed and synced\n`);
}

// ─── rt evidence review ───────────────────────────────────────────────────────

const REVIEW_CLOSING_HINT = "attach stays a separate held step (assured:capture-evidence A5)";

/** One-line prompt on stderr so it survives fzf's own stdout usage; resolves to the trimmed answer. */
function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    // rl.question, not a bare write: readline's line refresh would otherwise
    // clear text written directly ahead of it (same footgun as commit.ts).
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Real RedrawDeps for interactive use: shells out to $EDITOR and `fast-browser annotate`. */
function defaultRedrawDeps(): RedrawDeps {
  return {
    exec: async (argv) => {
      const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stdout, stderr };
    },
    editor: async (path) => {
      // EDITOR commonly carries flags (e.g. "code --wait"), so split into argv.
      const [editor = "vi", ...editorArgs] = (process.env.EDITOR || "vi").split(/\s+/);
      const proc = Bun.spawn([editor, ...editorArgs, path], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      await proc.exited;
    },
    screenshotsDir: () => join(process.env.HOME ?? homedir(), ".fast-browser", "screenshots"),
    tmpDir: () => tmpdir(),
  };
}

/** fzf --preview snippet: {1} (the requestId) resolves through a symlink dir built per invocation. */
function buildReviewPreviewCommand(previewDir: string): string {
  return `p=${shellQuote(previewDir)}"/"{1}".png"; ${buildImagePreviewSnippet()}`;
}

export async function reviewCommand(args: string[]): Promise<void> {
  let branch: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") helpExit();
    else if (arg === "--branch") { branch = args[++i] ?? null; if (!branch) usageExit("--branch requires a name"); }
    else usageExit(`unknown argument: ${arg}`);
  }

  let resumeQuery = "";
  let resumeValue: string | undefined;

  while (true) {
    let entries: EvidenceLedgerEntry[];
    try {
      entries = await evidenceList({ states: ["synced"], ...(branch ? { branch } : {}) });
    } catch (err) {
      infraExit(err);
    }

    if (entries.length === 0) {
      console.log(`\n  ${dim}no synced evidence waiting for review${reset}\n`);
      break;
    }

    // Group by branch so the picker can head each cluster when more than one
    // is present; a single --branch filter already names the branch in the
    // border label, so a redundant heading would just be clutter there.
    const byBranch = new Map<string, EvidenceLedgerEntry[]>();
    for (const e of entries) {
      const bucket = byBranch.get(e.branch) ?? [];
      bucket.push(e);
      byBranch.set(e.branch, bucket);
    }
    const branches = [...byBranch.keys()].sort();

    const previewDir = mkdtempSync(join(tmpdir(), "rt-evidence-review-"));
    try {
      const options: NavOption[] = [];
      const byId = new Map<string, EvidenceLedgerEntry>();
      for (const b of branches) {
        if (branches.length > 1) options.push(navSeparator(b));
        for (const e of byBranch.get(b)!) {
          byId.set(e.requestId, e);
          const treefile = e.files?.annotated ?? e.files?.base;
          if (treefile) {
            try {
              symlinkSync(treefile, join(previewDir, `${e.requestId}.png`));
            } catch {
              // Best-effort preview: a broken symlink just falls through to
              // the preview snippet's own "file" fallback branch.
            }
          }
          const redraws = e.redraws?.length ?? 0;
          options.push({
            value: e.requestId,
            label: `${e.slot} ${e.recipe} ${e.caseId}`,
            hint: `${e.state}${redraws ? `  redraws: ${redraws}` : ""}`,
          });
        }
      }

      const result = await runNavPicker({
        options,
        message: branch ? `evidence review: ${branch}` : "evidence review",
        header: "enter: provenance  ctrl-a: approve  ctrl-r: reject  ctrl-e: edit + redraw  esc: quit",
        expectKeys: ["ctrl-a", "ctrl-r", "ctrl-e"],
        preview: buildReviewPreviewCommand(previewDir),
        initialQuery: resumeQuery,
        resumeValue,
      });

      resumeQuery = "";
      resumeValue = undefined;

      if (!result || !result.value) break; // esc / cancel

      const { value: requestId, key, query } = result;
      const entry = byId.get(requestId);
      if (!entry) { resumeQuery = query; continue; }

      if (key === "ctrl-a") {
        try {
          await evidenceDecide(requestId, "approved");
        } catch (err) {
          infraExit(err);
        }
        console.log(`\n  ${green}✓${reset} approved ${bold}${requestId}${reset}\n`);
        resumeQuery = query;
        resumeValue = requestId;
        continue;
      }

      if (key === "ctrl-r") {
        const reasonAnswer = await promptLine("  reject reason: ");
        if (!reasonAnswer) {
          console.log(`\n  ${dim}reject cancelled (no reason given)${reset}\n`);
          resumeQuery = query;
          resumeValue = requestId;
          continue;
        }
        try {
          await evidenceDecide(requestId, "rejected", reasonAnswer);
        } catch (err) {
          infraExit(err);
        }
        console.log(`\n  ${yellow}✗${reset} rejected ${bold}${requestId}${reset}\n`);
        resumeQuery = query;
        resumeValue = requestId;
        continue;
      }

      if (key === "ctrl-e") {
        const redrawResult = await redrawAnnotations(entry, defaultRedrawDeps());
        if ("error" in redrawResult) {
          console.log(`\n  ${red}redraw failed:${reset} ${redrawResult.error}\n`);
          resumeQuery = query;
          resumeValue = requestId;
          continue;
        }
        try {
          await evidenceRedraw(requestId, redrawResult.annotatedPath);
        } catch (err) {
          infraExit(err);
        }
        console.log(`\n  ${green}✓${reset} redrawn ${bold}${requestId}${reset}\n`);
        resumeQuery = query;
        resumeValue = requestId;
        continue;
      }

      // Enter accepts the row with key === "". navigate.ts always adds
      // ctrl-up to --expect for back-navigation even though we never
      // advertise it in the header; treat anything other than a plain
      // accept as a no-op resume rather than accidentally showing provenance.
      if (key !== "") {
        resumeQuery = query;
        resumeValue = requestId;
        continue;
      }

      // Show the manifest's provenance, then return to the picker on the
      // same row. Approve never touches the MR; this view is read-only.
      if (entry.files?.manifest) {
        let manifestText: string;
        try {
          manifestText = readFileSync(entry.files.manifest, "utf8");
        } catch (err) {
          manifestText = `(could not read manifest: ${err instanceof Error ? err.message : String(err)})`;
        }
        let pretty = manifestText;
        try {
          pretty = JSON.stringify(JSON.parse(manifestText), null, 2);
        } catch {
          // Not JSON (or the read above failed): show it verbatim.
        }
        console.log(`\n${pretty}\n`);
      } else {
        console.log(`\n  ${dim}no manifest on file${reset}\n`);
      }
      await promptLine("  press enter to return to the picker ");
      resumeQuery = query;
      resumeValue = requestId;
    } finally {
      rmSync(previewDir, { recursive: true, force: true });
    }
  }

  console.log(`  ${dim}${REVIEW_CLOSING_HINT}${reset}\n`);
}
