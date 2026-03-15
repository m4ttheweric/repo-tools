import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "child_process";

// ── GitLab project constants ──────────────────────────────────────────────────

const PROJECT = "assured/assured-dev";
const PROJECT_ENCODED = "assured%2Fassured-dev";

// ── GitLab API helpers ────────────────────────────────────────────────────────

function glabApi(path) {
  const raw = execSync(`glab api "projects/${PROJECT_ENCODED}${path}"`, {
    encoding: "utf8",
    // glab must be on PATH; it reads auth from ~/.config/glab-cli
  });
  return JSON.parse(raw);
}

function glabApiText(path) {
  return execSync(`glab api "projects/${PROJECT_ENCODED}${path}"`, {
    encoding: "utf8",
  });
}

function ok(text) {
  return { content: [{ type: "text", text }] };
}

function err(text) {
  return { content: [{ type: "text", text }], isError: true };
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "assured-gitlab-ci",
  version: "1.0.0",
  description:
    "Inspects GitLab CI pipelines for the assured/assured-dev repo. " +
    "Use this server whenever the user asks about a failing pipeline, CI failures, " +
    "test failures, why a branch is failing, what's broken in CI, pipeline status, " +
    "or wants to investigate a GitLab pipeline on any branch or MR. " +
    "\n\n" +
    "IMPORTANT — CI STRUCTURE TO UNDERSTAND BEFORE INVESTIGATING: " +
    "Each branch/MR has TWO separate top-level pipelines: (1) a branch pipeline " +
    "(source=push) which runs on every commit to the branch, and (2) an MR pipeline " +
    "(source=merge_request_event) which runs when a merge request is open. " +
    "The MR pipeline contains a bridge job called 'dynamic-tests' that triggers a " +
    "CHILD pipeline — this child pipeline is where all the real tests run " +
    "(type-check, frontend unit tests, backend integration tests, etc.). " +
    "To investigate test failures you MUST look at the child pipeline, not the parent MR pipeline. " +
    "Use find_pipelines first to get oriented, then get_pipeline_jobs on the child pipeline ID.",
});

// ── find_pipelines ────────────────────────────────────────────────────────────

server.tool(
  "find_pipelines",
  "Find all relevant pipelines for a branch. Returns the latest branch pipeline and " +
    "latest MR pipeline, and automatically resolves the dynamic-tests child pipeline ID " +
    "from the MR pipeline. This is always the first tool to call when investigating a " +
    "failing pipeline or CI failure on a branch. " +
    "Use when: user asks why a branch is failing, what's broken in CI, pipeline status " +
    "for a branch, or to start any CI investigation.",
  {
    branch: z
      .string()
      .describe("Branch name, e.g. 'experimental/claim-export-import'"),
  },
  async ({ branch }) => {
    try {
      // Fetch up to 10 pipelines for this branch (covers both push and MR event sources)
      const pipelines = glabApi(
        `/pipelines?ref=${encodeURIComponent(branch)}&per_page=10&order_by=id&sort=desc`,
      );

      if (!pipelines.length) {
        // Also check if there are MR pipelines under refs/merge-requests/*/head
        return err(
          `No pipelines found for branch '${branch}'. ` +
            `Note: MR pipelines use ref 'refs/merge-requests/<number>/head' — ` +
            `if the branch has an open MR, try get_mr_pipelines instead.`,
        );
      }

      const branchPipeline = pipelines.find((p) => p.source === "push");
      const mrPipeline = pipelines.find(
        (p) => p.source === "merge_request_event",
      );

      const result = {
        branch,
        branchPipeline: branchPipeline
          ? {
              id: branchPipeline.id,
              status: branchPipeline.status,
              source: branchPipeline.source,
              ref: branchPipeline.ref,
              sha: branchPipeline.sha?.slice(0, 8),
              webUrl: branchPipeline.web_url,
              createdAt: branchPipeline.created_at,
            }
          : null,
        mrPipeline: null,
        dynamicTestsPipeline: null,
      };

      if (mrPipeline) {
        result.mrPipeline = {
          id: mrPipeline.id,
          status: mrPipeline.status,
          source: mrPipeline.source,
          ref: mrPipeline.ref,
          sha: mrPipeline.sha?.slice(0, 8),
          webUrl: mrPipeline.web_url,
          createdAt: mrPipeline.created_at,
        };

        // Resolve the dynamic-tests child pipeline via the bridges API
        try {
          const bridges = glabApi(`/pipelines/${mrPipeline.id}/bridges`);
          const dynamicTestsBridge = bridges.find(
            (b) => b.name === "dynamic-tests",
          );
          if (dynamicTestsBridge?.downstream_pipeline) {
            const dp = dynamicTestsBridge.downstream_pipeline;
            result.dynamicTestsPipeline = {
              id: dp.id,
              status: dp.status,
              webUrl: dp.web_url,
              bridgeJobId: dynamicTestsBridge.id,
              bridgeStatus: dynamicTestsBridge.status,
              note:
                "This is the child pipeline where all tests run. Use get_pipeline_jobs with this ID to see failures.",
            };
          }
        } catch {
          result.dynamicTestsPipeline = {
            error: "Could not resolve dynamic-tests child pipeline",
          };
        }
      }

      const lines = [JSON.stringify(result, null, 2)];

      if (result.dynamicTestsPipeline?.id) {
        lines.push(
          `\nNext step: call get_pipeline_jobs with pipelineId=${result.dynamicTestsPipeline.id} to see which tests failed.`,
        );
      } else if (result.mrPipeline) {
        lines.push(
          `\nNext step: call get_pipeline_jobs with pipelineId=${result.mrPipeline.id} to inspect jobs.`,
        );
      }

      return ok(lines.join("\n"));
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  },
);

// ── get_mr_pipelines ──────────────────────────────────────────────────────────

server.tool(
  "get_mr_pipelines",
  "List pipelines for an open merge request by MR number. Useful when the branch name " +
    "lookup doesn't return MR pipelines (MR pipelines use a special ref format). " +
    "Also resolves the dynamic-tests child pipeline for each MR pipeline.",
  {
    mrNumber: z.number().describe("The MR/PR number, e.g. 30466"),
    limit: z
      .number()
      .optional()
      .default(3)
      .describe("Number of recent MR pipelines to return (default 3)"),
  },
  async ({ mrNumber, limit }) => {
    try {
      const ref = `refs/merge-requests/${mrNumber}/head`;
      const pipelines = glabApi(
        `/pipelines?ref=${encodeURIComponent(ref)}&per_page=${limit}&order_by=id&sort=desc`,
      );

      if (!pipelines.length) {
        return err(`No pipelines found for MR !${mrNumber}`);
      }

      const results = pipelines.map((p) => {
        const entry = {
          id: p.id,
          status: p.status,
          ref: p.ref,
          sha: p.sha?.slice(0, 8),
          webUrl: p.web_url,
          createdAt: p.created_at,
          dynamicTestsPipeline: null,
        };

        try {
          const bridges = glabApi(`/pipelines/${p.id}/bridges`);
          const dtBridge = bridges.find((b) => b.name === "dynamic-tests");
          if (dtBridge?.downstream_pipeline) {
            entry.dynamicTestsPipeline = {
              id: dtBridge.downstream_pipeline.id,
              status: dtBridge.downstream_pipeline.status,
              webUrl: dtBridge.downstream_pipeline.web_url,
            };
          }
        } catch {
          // bridge lookup failed, continue
        }

        return entry;
      });

      const latest = results[0];
      const lines = [JSON.stringify(results, null, 2)];

      if (latest?.dynamicTestsPipeline?.id) {
        lines.push(
          `\nLatest dynamic-tests child pipeline: ${latest.dynamicTestsPipeline.id} (${latest.dynamicTestsPipeline.status})`,
          `Next step: call get_pipeline_jobs with pipelineId=${latest.dynamicTestsPipeline.id}`,
        );
      }

      return ok(lines.join("\n"));
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  },
);

// ── get_pipeline_jobs ─────────────────────────────────────────────────────────

server.tool(
  "get_pipeline_jobs",
  "List all jobs in a pipeline with their status, duration, and failure reason. " +
    "Also fetches bridge jobs (child pipeline triggers) and includes the downstream pipeline ID. " +
    "Use after find_pipelines to drill into the dynamic-tests child pipeline. " +
    "Use when: user wants to see which jobs failed, what tests are broken, job statuses.",
  {
    pipelineId: z.number().describe("The pipeline ID, e.g. 2385903614"),
    failedOnly: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, only return failed jobs"),
  },
  async ({ pipelineId, failedOnly }) => {
    try {
      let jobs, bridges;
      try {
        jobs = glabApi(`/pipelines/${pipelineId}/jobs?per_page=100`);
      } catch {
        jobs = [];
      }
      try {
        bridges = glabApi(`/pipelines/${pipelineId}/bridges`);
      } catch {
        bridges = [];
      }

      const allJobs = [
        ...jobs.map((j) => ({
          id: j.id,
          name: j.name,
          stage: j.stage,
          status: j.status,
          duration: j.duration ? Math.round(j.duration) + "s" : null,
          failureReason: j.failure_reason || null,
          allowFailure: j.allow_failure,
          type: "job",
        })),
        ...bridges.map((b) => ({
          id: b.id,
          name: b.name,
          stage: b.stage,
          status: b.status,
          duration: b.duration ? Math.round(b.duration) + "s" : null,
          failureReason: b.failure_reason || null,
          allowFailure: b.allow_failure,
          type: "bridge",
          downstreamPipelineId: b.downstream_pipeline?.id ?? null,
          downstreamStatus: b.downstream_pipeline?.status ?? null,
        })),
      ].sort((a, b) => a.id - b.id);

      const filtered = failedOnly
        ? allJobs.filter((j) => j.status === "failed")
        : allJobs;

      const failed = allJobs.filter(
        (j) => j.status === "failed" && !j.allowFailure,
      );

      const lines = [
        `Pipeline ${pipelineId} — ${allJobs.length} jobs total, ${failed.length} blocking failures\n`,
        JSON.stringify(filtered, null, 2),
      ];

      if (failed.length > 0) {
        lines.push(
          `\nBlocking failures: ${failed.map((j) => j.name).join(", ")}`,
          `Next step: call get_job_log with a jobId from the list above to see the failure output.`,
        );
      }

      return ok(lines.join("\n"));
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  },
);

// ── get_job_log ───────────────────────────────────────────────────────────────

server.tool(
  "get_job_log",
  "Get the log output for a specific CI job. Returns the last portion of the log " +
    "which contains the failure output. Use when: user wants to see what a job failed on, " +
    "see error output, understand why a specific test or check failed.",
  {
    jobId: z.number().describe("The job ID, e.g. 13497976028"),
    tailLines: z
      .number()
      .optional()
      .default(120)
      .describe("Number of lines from the end of the log to return (default 120)"),
  },
  async ({ jobId, tailLines }) => {
    try {
      const raw = glabApiText(`/jobs/${jobId}/trace`);
      // Strip ANSI escape codes and GitLab section markers
      const clean = raw
        .replace(/\x1b\[[0-9;]*[mGKHF]/g, "")
        .replace(/section_(start|end):[0-9]+:[^\r\n]*/g, "")
        .replace(/\r/g, "");

      const lines = clean.split("\n");
      const tail = lines.slice(-tailLines).join("\n");

      return ok(
        `Job ${jobId} log (last ${tailLines} lines of ${lines.length} total):\n\n${tail}`,
      );
    } catch (e) {
      return err(`Error fetching log for job ${jobId}: ${e.message}`);
    }
  },
);

// ── Transport ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
