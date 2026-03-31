import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "child_process";

// ── Constants ─────────────────────────────────────────────────────────────────

const NAMESPACE = "dynamic-environments-with-argo-cd";
const KUBECTL_CONTEXT = "Dev Preview Cluster";

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureContext() {
  try {
    execSync("sdm kubernetes update-config", { encoding: "utf8" });
  } catch {
    // best-effort — if SDM isn't running, kubectl may still work if context is set
  }
}

function kubectl(args: string): string {
  return execSync(
    `kubectl --context="${KUBECTL_CONTEXT}" -n ${NAMESPACE} ${args}`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "preview-cluster",
  version: "1.0.0",
  description:
    "Inspects the Assured Dev Preview Kubernetes cluster. " +
    "Use this server when a preview environment is failing to deploy, " +
    "a pod is crash-looping, a deployment is degraded, or the preview:env:create " +
    "CI job fails. Connects via StrongDM (SDM) to the Dev Preview Cluster. " +
    "The preview namespace is 'dynamic-environments-with-argo-cd'. " +
    "Preview environments are named 'preview-<mrNumber>' (e.g. preview-30466).",
});

// ── get_preview_pods ──────────────────────────────────────────────────────────

server.tool(
  "get_preview_pods",
  "List all pods for a preview environment by MR number. Shows pod status, restarts, " +
    "and age so you can identify which pods are crashing. " +
    "Use when: which pods are running for MR 30466, what's the pod status for preview, " +
    "is the backend pod healthy, find the crashing pod, check pod status.",
  {
    mrNumber: z
      .number()
      .describe("The MR number, e.g. 30466. Used to filter pods by preview label."),
  },
  async ({ mrNumber }) => {
    try {
      ensureContext();
      const raw = kubectl(
        `get pods -l "app.kubernetes.io/instance=preview-${mrNumber}" -o wide 2>/dev/null || kubectl --context="${KUBECTL_CONTEXT}" -n ${NAMESPACE} get pods | grep "preview-${mrNumber}"`,
      );
      if (!raw.trim()) {
        return err(
          `No pods found for preview-${mrNumber}. ` +
            `Ensure the preview environment has been deployed and SDM is connected.`,
        );
      }
      return ok(`Pods for preview-${mrNumber}:\n\n${raw}`);
    } catch (e: unknown) {
      // fallback: grep approach
      try {
        ensureContext();
        const raw = execSync(
          `kubectl --context="${KUBECTL_CONTEXT}" -n ${NAMESPACE} get pods 2>&1 | grep "preview-${mrNumber}"`,
          { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 },
        );
        return ok(`Pods for preview-${mrNumber}:\n\n${raw}`);
      } catch (e2: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return err(`Error listing pods: ${message}`);
      }
    }
  },
);

// ── get_preview_pod_logs ──────────────────────────────────────────────────────

server.tool(
  "get_preview_pod_logs",
  "Get logs from a pod in a preview environment. Automatically fetches previous " +
    "container logs (--previous) when the pod is in CrashLoopBackOff. " +
    "Use when: why is the backend pod crashing, show me the pod logs, what error is " +
    "the pod throwing, preview:env:create failed, pod is in CrashLoopBackOff, " +
    "deployment is degraded, check backend logs for MR.",
  {
    podName: z
      .string()
      .describe(
        "Full pod name, e.g. 'preview-30466-assured-backend-5d57fc59d6-cmtvd'. " +
          "Get this from get_preview_pods first.",
      ),
    previous: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Fetch logs from the previous (crashed) container instance. Default true — " +
          "use this for CrashLoopBackOff pods to see the actual crash reason.",
      ),
    tailLines: z
      .number()
      .optional()
      .default(100)
      .describe("Number of log lines to return from the end (default 100)."),
  },
  async ({ podName, previous, tailLines }) => {
    try {
      ensureContext();
      const previousFlag = previous ? "--previous" : "";
      const raw = kubectl(
        `logs ${podName} ${previousFlag} --tail=${tailLines} 2>&1`,
      );
      return ok(
        `Logs for pod ${podName}${previous ? " (previous container)" : ""}:\n\n${raw}`,
      );
    } catch (e: unknown) {
      // If --previous fails (pod hasn't restarted yet), try without it
      if (previous) {
        try {
          const raw = kubectl(`logs ${podName} --tail=${tailLines} 2>&1`);
          return ok(
            `Logs for pod ${podName} (current container — no previous logs available):\n\n${raw}`,
          );
        } catch {
          // fall through to original error
        }
      }
      const message = e instanceof Error ? e.message : String(e);
      return err(`Error fetching logs for ${podName}: ${message}`);
    }
  },
);

// ── describe_preview_pod ──────────────────────────────────────────────────────

server.tool(
  "describe_preview_pod",
  "Describe a pod to get its events, conditions, and resource details. Useful for " +
    "diagnosing image pull failures, OOMKilled, liveness probe failures, or scheduling " +
    "issues that don't show in logs. " +
    "Use when: pod won't start, image pull error, OOMKilled, liveness probe failing, " +
    "pod stuck in Pending, describe the pod, check pod events.",
  {
    podName: z
      .string()
      .describe(
        "Full pod name, e.g. 'preview-30466-assured-backend-5d57fc59d6-cmtvd'. " +
          "Get this from get_preview_pods first.",
      ),
  },
  async ({ podName }) => {
    try {
      ensureContext();
      const raw = kubectl(`describe pod ${podName}`);
      return ok(`Description of pod ${podName}:\n\n${raw}`);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return err(`Error describing pod ${podName}: ${message}`);
    }
  },
);

// ── get_preview_deployment ────────────────────────────────────────────────────

server.tool(
  "get_preview_deployment",
  "Get the status and events for a specific deployment in a preview environment. " +
    "Useful for understanding why a deployment is degraded or stuck rolling out. " +
    "Use when: deployment is degraded, rollout is stuck, check deployment status, " +
    "why is the backend deployment failing, deployment exceeded progress deadline.",
  {
    mrNumber: z.number().describe("The MR number, e.g. 30466."),
    deploymentName: z
      .string()
      .optional()
      .describe(
        "Deployment name suffix after 'preview-<mrNumber>-', e.g. 'assured-backend'. " +
          "Defaults to 'assured-backend'.",
      ),
  },
  async ({ mrNumber, deploymentName = "assured-backend" }) => {
    try {
      ensureContext();
      const fullName = `preview-${mrNumber}-${deploymentName}`;
      const describe = kubectl(`describe deployment ${fullName}`);
      return ok(`Deployment ${fullName}:\n\n${describe}`);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return err(`Error: ${message}`);
    }
  },
);

// ── Transport ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
