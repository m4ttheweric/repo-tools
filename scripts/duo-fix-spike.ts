#!/usr/bin/env bun
/**
 * duo-fix-spike — validate that GitLab Duo's Fix Pipeline foundational flow
 * can replace rt's homegrown auto-fix pipeline.
 *
 * Subcommands:
 *   probe <mr-iid>             — read-only check of Duo readiness for this MR
 *   invoke <mr-iid>            — fire fix_pipeline/v1 against the MR's latest failed pipeline
 *   watch <workflow-id>        — poll workflow status until terminal
 *   find-fix-mr <source-branch> [author]
 *                              — list MRs authored by Duo (or `author`) targeting the source branch
 *
 * 0 repo footprint: all GitLab API calls via `glab`. No writes to any project repo.
 *
 * Hardcoded for acme-dev (project 15627023) for this spike. Override with
 *   DUO_FIX_SPIKE_PROJECT=<numeric id> DUO_FIX_SPIKE_FULL_PATH=<group/project>
 */

import { execSync, spawnSync } from "node:child_process";

const PROJECT_ID  = process.env.DUO_FIX_SPIKE_PROJECT   ?? "15627023";
const FULL_PATH   = process.env.DUO_FIX_SPIKE_FULL_PATH ?? "acme/acme-dev";
const PROJECT_GID = `gid://gitlab/Project/${PROJECT_ID}`;
const FIX_PIPELINE_ITEM_ID = "gid://gitlab/Ai::Catalog::Item/1800";

// FIX_PIPELINE_AGENT_PRIVILEGES from gitlab-org/gitlab constants.js
const FIX_PIPELINE_PRIVS = [1, 2, 3, 4, 5];

function glab(args: string[], input?: string): string {
  const r = spawnSync("glab", args, { encoding: "utf8", input });
  if (r.status !== 0) {
    throw new Error(`glab ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function glabJson<T = any>(args: string[]): T {
  return JSON.parse(glab(args));
}

function gql<T = any>(query: string, vars: Record<string, unknown> = {}): T {
  const varArgs = Object.entries(vars).flatMap(
    ([k, v]) => ["-f", `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`],
  );
  return JSON.parse(glab(["api", "graphql", "-f", `query=${query}`, ...varArgs])) as T;
}

// ── probe ────────────────────────────────────────────────────────────────────

async function probe(mrIid: string) {
  console.log(`Probing Duo readiness for ${FULL_PATH}!${mrIid}…\n`);

  // 1. Project-level Duo status
  const status = gql<any>(`
    query($path: ID!, $itemId: AiCatalogItemID!, $projectId: ProjectID!) {
      project(fullPath: $path) {
        duoWorkflowStatusCheck { enabled remoteFlowsEnabled createDuoWorkflowForCiAllowed }
      }
      item: aiCatalogItem(id: $itemId) {
        name
        configurationForProject(projectId: $projectId) { id enabled }
      }
    }
  `, { path: FULL_PATH, itemId: FIX_PIPELINE_ITEM_ID, projectId: PROJECT_GID });

  const dws = status.data?.project?.duoWorkflowStatusCheck;
  const cfg = status.data?.item?.configurationForProject;
  console.log("Duo on project:", dws);
  console.log("Fix Pipeline configured for project:", cfg ?? "❌ NOT CONFIGURED");

  // 2. MR + latest failed pipeline
  const mr = glabJson<any>(["api", `/projects/${PROJECT_ID}/merge_requests/${mrIid}`]);
  console.log(`\nMR !${mr.iid} "${mr.title}"`);
  console.log("  source_branch:", mr.source_branch);
  console.log("  target_branch:", mr.target_branch);
  console.log("  draft:", mr.draft, " | state:", mr.state);
  console.log("  head_pipeline:", mr.head_pipeline?.id, mr.head_pipeline?.status);

  const pipelines = glabJson<any[]>(["api",
    `/projects/${PROJECT_ID}/pipelines?ref=${encodeURIComponent(mr.source_branch)}&status=failed&per_page=3`,
  ]);
  console.log("  recent failed pipelines on source_branch:",
    pipelines.map(p => ({ id: p.id, web_url: p.web_url, updated: p.updated_at })),
  );

  const ready = dws?.enabled && dws?.remoteFlowsEnabled && dws?.createDuoWorkflowForCiAllowed && cfg?.enabled;
  console.log("\nReady to invoke:", ready ? "✅" : "❌");
  if (!ready) {
    if (!cfg) console.log("  Action: ask a group Owner to enable Fix CI/CD Pipeline at");
    console.log("  https://gitlab.com/groups/acme/-/automate/ai_agents/catalog");
  }
}

// ── invoke ───────────────────────────────────────────────────────────────────

async function invoke(mrIid: string, opts: { pipelineId?: string; dry?: boolean }) {
  const mr = glabJson<any>(["api", `/projects/${PROJECT_ID}/merge_requests/${mrIid}`]);

  let pipelineUrl: string;
  if (opts.pipelineId) {
    pipelineUrl = `https://gitlab.com/${FULL_PATH}/-/pipelines/${opts.pipelineId}`;
  } else {
    const fails = glabJson<any[]>(["api",
      `/projects/${PROJECT_ID}/pipelines?ref=${encodeURIComponent(mr.source_branch)}&status=failed&per_page=1`,
    ]);
    if (!fails.length) throw new Error(`No failed pipeline on ${mr.source_branch}; pass --pipeline <id>.`);
    pipelineUrl = fails[0].web_url;
  }

  const mrUrl = `https://gitlab.com/${FULL_PATH}/-/merge_requests/${mrIid}`;

  const payload = {
    project_id: Number(PROJECT_ID),
    start_workflow: true,
    goal: pipelineUrl,
    environment: "web",
    workflow_definition: "fix_pipeline/v1",
    agent_privileges: FIX_PIPELINE_PRIVS,
    source_branch: mr.source_branch,
    additional_context: [
      { Category: "merge_request", Content: JSON.stringify({ url: mrUrl }) },
      { Category: "pipeline",      Content: JSON.stringify({ source_branch: mr.source_branch }) },
    ],
  };

  console.log("POST /api/v4/ai/duo_workflows/workflows");
  console.log(JSON.stringify(payload, null, 2));

  if (opts.dry) { console.log("\n(dry-run: not sent)"); return; }

  const out = glab(
    ["api", "--method", "POST", "/ai/duo_workflows/workflows", "--input", "-"],
    JSON.stringify(payload),
  );
  console.log("\nResponse:\n", out);
}

// ── watch ────────────────────────────────────────────────────────────────────

async function watch(workflowId: string) {
  const wfGid = workflowId.startsWith("gid://")
    ? workflowId : `gid://gitlab/Ai::DuoWorkflows::Workflow/${workflowId}`;

  for (;;) {
    const r = gql<any>(`
      query($id: AiDuoWorkflowsWorkflowID!) {
        duoWorkflowWorkflow(id: $id) {
          id status statusName statusGroup goal humanStatus
          resourceIid resourceWebUrl webUrl
        }
      }
    `, { id: wfGid });
    const wf = r.data?.duoWorkflowWorkflow;
    if (!wf) { console.log("not found:", JSON.stringify(r)); return; }
    const stamp = new Date().toISOString().slice(11, 19);
    console.log(`[${stamp}] ${wf.status} (${wf.statusGroup}) — ${wf.humanStatus ?? ""}`);
    if (["COMPLETED", "FAILED", "CANCELED"].includes(wf.statusGroup)) {
      console.log("\nWorkflow done. session:", wf.webUrl, "associated MR iid:", wf.resourceIid);
      return;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}

// ── find-fix-mr ──────────────────────────────────────────────────────────────

async function findFixMr(sourceBranch: string, author = "m4ttheweric") {
  const list = glabJson<any[]>(["api",
    `/projects/${PROJECT_ID}/merge_requests?target_branch=${encodeURIComponent(sourceBranch)}&author_username=${author}&order_by=created_at&per_page=10`,
  ]);
  if (!list.length) { console.log("No fix MRs found targeting", sourceBranch); return; }
  for (const m of list) {
    console.log(`!${m.iid}  state=${m.state}  src=${m.source_branch}  → tgt=${m.target_branch}`);
    console.log(`  ${m.web_url}`);
  }
}

// ── dispatch ─────────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter(a => a.startsWith("--")));
const positional = rest.filter(a => !a.startsWith("--"));

try {
  switch (cmd) {
    case "probe":       await probe(positional[0]); break;
    case "invoke":      await invoke(positional[0], {
                          pipelineId: process.env.PIPELINE_ID,
                          dry: flags.has("--dry"),
                        }); break;
    case "watch":       await watch(positional[0]); break;
    case "find-fix-mr": await findFixMr(positional[0], positional[1]); break;
    default:
      console.log("usage: duo-fix-spike.ts (probe|invoke|watch|find-fix-mr) <arg> [--dry]");
      process.exit(1);
  }
} catch (err: any) {
  console.error("error:", err.message ?? err);
  if (err.stderr) console.error(err.stderr.toString?.());
  process.exit(2);
}
