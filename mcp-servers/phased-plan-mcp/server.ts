import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "fs";
import { join, dirname, resolve, isAbsolute } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Types ────────────────────────────────────────────────────────────────────

interface IndexEntry {
  directory: string;
  registered: string;
}

interface PlanIndex {
  [planId: string]: IndexEntry;
}

interface PhaseEntry {
  id: number;
  name: string;
  file: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "DONE";
  agent: string | null;
  started: string | null;
  completed: string | null;
  depends_on: number[];
  outputs: string[];
  context_snapshot?: Record<string, string | number>;
  notes?: string;
  expected_counts?: { key: string; min: number; max?: number }[];
  required_paths?: string[];
}

interface PlanStatus {
  plan_id: string;
  title: string;
  description: string;
  directory: string;
  created: string;
  phases: PhaseEntry[];
}

interface PhaseInput {
  id: number;
  name: string;
  goal: string;
  depends_on: number[];
  steps: { title: string; instructions: string }[];
  wiring_checks?: string[];
  verification?: string[];
  outputs?: string[];
  context_snapshot?: string[];
  expected_counts?: { key: string; min: number; max?: number }[];
  required_paths?: string[];
}

// ── Global index (registry of all plans) ─────────────────────────────────────

const INDEX_DIR = join(process.env.HOME || "/tmp", ".phased-plans");
const INDEX_PATH = join(INDEX_DIR, "index.json");

function readIndex(): PlanIndex {
  try {
    return JSON.parse(readFileSync(INDEX_PATH, "utf8")) as PlanIndex;
  } catch {
    return {};
  }
}

function writeIndex(index: PlanIndex): void {
  if (!existsSync(INDEX_DIR)) mkdirSync(INDEX_DIR, { recursive: true });
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + "\n", "utf8");
}

function registerPlan(planId: string, dir: string): void {
  const index = readIndex();
  index[planId] = { directory: dir, registered: nowISO() };
  writeIndex(index);
}

function unregisterPlan(planId: string): void {
  const index = readIndex();
  delete index[planId];
  writeIndex(index);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolvePlanDir(planId: string): string | null {
  const index = readIndex();
  const entry = index[planId];
  return entry?.directory || null;
}

function statusPath(dir: string): string {
  return join(dir, "STATUS.json");
}

function readStatus(planId: string): PlanStatus | null {
  const dir = resolvePlanDir(planId);
  if (!dir) return null;
  try {
    return JSON.parse(readFileSync(statusPath(dir), "utf8")) as PlanStatus;
  } catch {
    return null;
  }
}

function writeStatus(planId: string, status: PlanStatus): void {
  const dir = resolvePlanDir(planId);
  if (!dir) return;
  writeFileSync(
    statusPath(dir),
    JSON.stringify(status, null, 2) + "\n",
    "utf8",
  );
}

function phaseFilename(phaseIndex: number): string {
  return `phase-${phaseIndex}.md`;
}

function phasePath(dir: string, phaseIndex: number): string {
  return join(dir, phaseFilename(phaseIndex));
}

function readPhaseDoc(planId: string, phaseIndex: number): string | null {
  const dir = resolvePlanDir(planId);
  if (!dir) return null;
  try {
    return readFileSync(phasePath(dir, phaseIndex), "utf8");
  } catch {
    return null;
  }
}

function writePhaseDoc(planId: string, phaseIndex: number, content: string): void {
  const dir = resolvePlanDir(planId);
  if (!dir) return;
  writeFileSync(phasePath(dir, phaseIndex), content, "utf8");
}

function listPlanIds(): string[] {
  const index = readIndex();
  return Object.keys(index).sort();
}

function nowISO(): string {
  return new Date().toISOString();
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// ── Phase doc generation ─────────────────────────────────────────────────────

function generatePhaseDoc(
  phase: PhaseInput,
  allPhases: PhaseInput[],
  planId: string,
  planDir: string,
): string {
  const prereqs =
    phase.depends_on.length > 0
      ? phase.depends_on
          .map((i) => {
            const dep = allPhases.find((p) => p.id === i);
            return `Phase ${i}${dep ? ` (${dep.name})` : ""}`;
          })
          .join(", ")
      : "None — this is the first phase.";

  // Cross-phase output validation: verify outputs from prerequisite phases
  const depOutputChecks = phase.depends_on
    .map((depId) => {
      const dep = allPhases.find((p) => p.id === depId);
      if (!dep?.outputs?.length) return null;
      return dep.outputs
        .map((out) => `- [ ] Verify Phase ${depId} output: ${out}`)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n");

  const stepsBlock = phase.steps
    .map(
      (step, i) =>
        `## Step ${i + 1}: ${step.title}\n\n${step.instructions}\n\n\`\`\`bash\ngit add -A && git commit -m "phase-${phase.id}: ${step.title.toLowerCase()}"\n\`\`\``,
    )
    .join("\n\n");

  const wiringChecks = (phase.wiring_checks || [])
    .map((check) => `- [ ] ${check}`)
    .join("\n");

  const verificationChecks = (phase.verification || [])
    .map((v) => `- [ ] ${v}`)
    .join("\n");

  const nextPhase =
    allPhases.find(
      (p) => p.depends_on?.includes(phase.id) && p.id === phase.id + 1,
    ) || allPhases.find((p) => p.id === phase.id + 1);

  const nextPromptBlock = nextPhase
    ? `## Next Agent Prompt\n\n> I'm executing Phase ${nextPhase.id} (${nextPhase.name}) of the plan "${planId}". Read these documents in order:\n>\n> 1. \`${join(planDir, "STATUS.json")}\` — current plan status\n> 2. \`${phasePath(planDir, nextPhase.id)}\` — your task\n>\n> Phase ${phase.id} (${phase.name}) is complete. ${(phase.outputs || []).join(". ")}.\n>\n> Follow the conventions: incremental commits after each step, run all wiring checks, ensure git status is clean. Update the phase status when done using the phased-plan MCP tools.`
    : `## 🎉 Plan Complete\n\nThis is the final phase. No next agent prompt needed.`;

  const setupPrereqValidation = depOutputChecks
    ? `\n### Prerequisite Output Verification\n\nBefore starting, verify that the previous phase(s) actually produced their declared outputs:\n\n${depOutputChecks}\n`
    : "";

  return `<!-- STATUS: NOT_STARTED -->
<!-- AGENT: -->
<!-- COMPLETED: -->

# Phase ${phase.id}: ${phase.name}

**Goal:** ${phase.goal}

**Prerequisites:** ${prereqs}

---

## Setup

\`\`\`bash
# 1. Verify prerequisites are done
# (check STATUS.json or previous phase docs)

# 2. Verify clean working state
test -z "$(git status --porcelain)" && echo "✅ clean" || echo "❌ dirty"

# 3. Mark phase as started
# Use MCP tool: start_phase("${planId}", ${phase.id})
\`\`\`
${setupPrereqValidation}
---

${stepsBlock}

---

## Wiring Check

${wiringChecks || "No wiring checks defined for this phase."}

---

## Teardown

\`\`\`bash
# Context snapshot — IMPORTANT: always provide this when calling complete_phase
echo "=== CONTEXT SNAPSHOT ==="
${(phase.context_snapshot || ["echo 'Phase complete'"]).join("\n")}
test -z "$(git status --porcelain)" && echo "✅ git clean" || echo "❌ dirty"
\`\`\`

## Verification

${verificationChecks || "No verification steps defined."}

Mark phase as done — **include a context_snapshot** so the next agent has state:
\`\`\`
# Use MCP tool: complete_phase("${planId}", ${phase.id}, { context_snapshot: { ... } })
\`\`\`

---

${nextPromptBlock}
`;
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "phased-plan",
  version: "1.0.0",
  description:
    "Manages phased execution plans for complex multi-session work. " +
    "Use this server when work needs to be broken into phases that different agent sessions " +
    "can execute independently. Each phase has setup, steps with incremental commits, " +
    "wiring checks, teardown, and a pre-built prompt for the next agent. " +
    "Plans are created in the user's working directory so they appear in the IDE file tree. " +
    "Typical workflow: create_plan → start_phase → (execute steps) → complete_phase → get_next_prompt for handoff. " +
    "Use when the user says: break this into phases, create a phased plan, " +
    "make this executable by multiple agents, set up a migration plan, " +
    "create handoff documents, orchestrate across sessions.",
});

// ── create_plan ──────────────────────────────────────────────────────────────

server.tool(
  "create_plan",
  "Create a new phased execution plan. Generates STATUS.json and phase markdown documents " +
    "with setup/teardown/wiring-check structure in the specified directory. The plan directory " +
    "is created inside the user's project so it appears in their IDE file tree. " +
    "Use when setting up a new multi-phase project, migration, refactoring, or any work " +
    "too large for a single session. " +
    "TIP: If you have an existing implementation_plan.md, call plan_from_doc first to get " +
    "decomposition guidance before calling this tool. " +
    "Best practice: include a Phase 0 for pre-flight checks (verify repos are clean, " +
    "dependencies are met, environment is ready) and a final phase for end-to-end " +
    "verification (full build, smoke tests, cleanup of scaffolding).",
  {
    plan_id: z
      .string()
      .describe(
        "Unique ID for the plan, e.g. 'workforge-migration', 'auth-refactor'",
      ),
    directory: z
      .string()
      .describe(
        "Absolute path where the plan directory should be created. " +
          "This should be inside the user's project/repo so files are visible in their IDE. " +
          "Example: '/Users/matthew/Documents/github/my-repo/plans/migration'",
      ),
    title: z.string().describe("Human-readable title for the plan"),
    description: z
      .string()
      .describe("Brief description of the overall goal"),
    phases: z
      .array(
        z.object({
          id: z.number().describe("Phase number (0-indexed)"),
          name: z.string().describe("Phase name, e.g. 'Pre-Migration Prep'"),
          goal: z
            .string()
            .describe("One-sentence goal for this phase"),
          depends_on: z
            .array(z.number())
            .describe("Phase IDs that must be DONE before this one starts"),
          steps: z
            .array(
              z.object({
                title: z.string().describe("Step title"),
                instructions: z
                  .string()
                  .describe(
                    "Detailed step instructions (markdown). Include bash commands, file contents, etc.",
                  ),
              }),
            )
            .describe("Ordered steps within the phase"),
          wiring_checks: z
            .array(z.string())
            .optional()
            .describe(
              "E2E wiring verification items (things agents often forget to connect)",
            ),
          verification: z
            .array(z.string())
            .optional()
            .describe("Final verification checklist items"),
          outputs: z
            .array(z.string())
            .optional()
            .describe(
              "What this phase produces (used in the next agent's prompt)",
            ),
          context_snapshot: z
            .array(z.string())
            .optional()
            .describe(
              "Bash commands to run in teardown to capture state for next agent",
            ),
          expected_counts: z
            .array(
              z.object({
                key: z.string().describe("Key name that must appear in context_snapshot (e.g. 'packages', 'apps')"),
                min: z.number().describe("Minimum acceptable value"),
                max: z.number().optional().describe("Maximum acceptable value (omit for no upper bound)"),
              }),
            )
            .optional()
            .describe(
              "Expected count ranges for context_snapshot values. complete_phase will reject if snapshot values fall outside these ranges.",
            ),
          required_paths: z
            .array(z.string())
            .optional()
            .describe(
              "Paths (relative to plan directory's parent) that must exist when phase completes. complete_phase checks existence before allowing DONE.",
            ),
        }),
      )
      .describe("Ordered array of phases"),
  },
  async ({ plan_id, directory, title, description, phases }) => {
    // Validate absolute path
    if (!isAbsolute(directory)) {
      return err(
        `Directory must be an absolute path. Got: '${directory}'. ` +
          "Example: '/Users/matthew/Documents/github/my-repo/plans/migration'",
      );
    }

    const dir = resolve(directory);

    if (existsSync(dir) && existsSync(join(dir, "STATUS.json"))) {
      return err(
        `Plan already exists at ${dir}. Use a different directory or delete the existing plan.`,
      );
    }

    mkdirSync(dir, { recursive: true });

    // Register in global index so list_plans can find it
    registerPlan(plan_id, dir);

    // Create STATUS.json
    const status: PlanStatus = {
      plan_id,
      title,
      description,
      directory: dir,
      created: nowISO(),
      phases: phases.map((p) => ({
        id: p.id,
        name: p.name,
        file: phaseFilename(p.id),
        status: "NOT_STARTED",
        agent: null,
        started: null,
        completed: null,
        depends_on: p.depends_on,
        outputs: p.outputs || [],
        ...(p.expected_counts?.length ? { expected_counts: p.expected_counts } : {}),
        ...(p.required_paths?.length ? { required_paths: p.required_paths } : {}),
      })),
    };

    writeFileSync(
      statusPath(dir),
      JSON.stringify(status, null, 2) + "\n",
      "utf8",
    );

    // Generate phase docs
    for (const phase of phases) {
      const doc = generatePhaseDoc(phase, phases, plan_id, dir);
      writeFileSync(phasePath(dir, phase.id), doc, "utf8");
    }

    // Generate README
    const readme = `# ${title}\n\n${description}\n\n## Phases\n\n${phases.map((p) => `- [ ] **Phase ${p.id}** — [${p.name}](${phaseFilename(p.id)}) — ${p.goal}`).join("\n")}\n\n## Conventions\n\n- Each phase has: **Setup → Steps (with commits) → Wiring Check → Teardown → Next Agent Prompt**\n- Commit after each step: \`phase-N: step description\`\n- Git status must be clean at end of each phase\n- Use MCP tools to update phase status: \`start_phase\`, \`complete_phase\`\n- Use \`get_next_prompt\` to get the pre-built prompt for the next agent session\n`;

    writeFileSync(join(dir, "README.md"), readme, "utf8");

    return ok(
      `Created plan '${plan_id}' at ${dir}\n\nFiles generated:\n- STATUS.json\n- README.md\n${phases.map((p) => `- ${phaseFilename(p.id)} (${p.name})`).join("\n")}\n\nTotal phases: ${phases.length}\nPlan directory is inside your project — files will appear in your IDE file tree.\nStart with: get_next_prompt("${plan_id}") to get the prompt for Phase 0.`,
    );
  },
);

// ── list_plans ───────────────────────────────────────────────────────────────

server.tool(
  "list_plans",
  "List all phased plans with their current status. " +
    "Scans the global index to find plans across all repos. " +
    "Use when asking: what plans exist, show me active plans, " +
    "what migrations are in progress, what's the status of my plans.",
  {},
  async () => {
    const index = readIndex();
    const planIds = Object.keys(index).sort();

    if (planIds.length === 0) {
      return ok(
        "No plans found. Use create_plan to create one. Plans will be stored in your project directory.",
      );
    }

    const plans = planIds.map((id) => {
      const entry = index[id];
      const dir = entry.directory;
      let status: PlanStatus | null = null;
      try {
        status = JSON.parse(readFileSync(statusPath(dir), "utf8")) as PlanStatus;
      } catch {}

      if (!status) {
        return {
          plan_id: id,
          title: "(status file missing)",
          directory: dir,
          progress: "unknown",
          current: "ERROR",
        };
      }

      const done = status.phases.filter((p) => p.status === "DONE").length;
      const inProgress = status.phases.find(
        (p) => p.status === "IN_PROGRESS",
      );
      return {
        plan_id: id,
        title: status.title,
        directory: dir,
        progress: `${done}/${status.phases.length}`,
        current: inProgress
          ? `Phase ${inProgress.id}: ${inProgress.name}`
          : done === status.phases.length
            ? "COMPLETE"
            : "WAITING",
      };
    });

    return ok(JSON.stringify(plans, null, 2));
  },
);

// ── get_plan_status ──────────────────────────────────────────────────────────

server.tool(
  "get_plan_status",
  "Get detailed status of a specific plan, including all phases and their states. " +
    "Use when asking: what's the status of a plan, which phases are done, " +
    "what's next in the plan, show me the plan status.",
  {
    plan_id: z.string().describe("Plan ID"),
  },
  async ({ plan_id }) => {
    const status = readStatus(plan_id);
    if (!status) {
      return err(
        `Plan '${plan_id}' not found. Available: ${listPlanIds().join(", ") || "none"}`,
      );
    }
    return ok(JSON.stringify(status, null, 2));
  },
);

// ── get_phase ────────────────────────────────────────────────────────────────

server.tool(
  "get_phase",
  "Read the full markdown document for a specific phase. " +
    "Returns the complete phase doc with setup, steps, wiring checks, and teardown. " +
    "Use when an agent needs to execute a specific phase or review its instructions. " +
    "Use when asking: show me phase 2, what are the instructions for this phase, " +
    "read the phase doc, what does this phase involve.",
  {
    plan_id: z.string().describe("Plan ID"),
    phase_id: z.number().describe("Phase number (0-indexed)"),
  },
  async ({ plan_id, phase_id }) => {
    const dir = resolvePlanDir(plan_id);
    if (!dir) {
      return err(`Plan '${plan_id}' not found.`);
    }
    const doc = readPhaseDoc(plan_id, phase_id);
    if (!doc) {
      return err(`Phase ${phase_id} not found in plan '${plan_id}'.`);
    }
    return ok(`# Phase document: ${phasePath(dir, phase_id)}\n\n${doc}`);
  },
);

// ── start_phase ──────────────────────────────────────────────────────────────

server.tool(
  "start_phase",
  "Mark a phase as IN_PROGRESS. Checks that all dependencies are DONE first. " +
    "Use when an agent begins executing a phase. Records the agent name and start time. " +
    "Use when asking: begin this phase, I'm starting phase 1, kick off the next phase. " +
    "Always call this before beginning work on a phase.",
  {
    plan_id: z.string().describe("Plan ID"),
    phase_id: z.number().describe("Phase number to start"),
    agent: z
      .string()
      .optional()
      .describe("Agent/session identifier for tracking"),
  },
  async ({ plan_id, phase_id, agent }) => {
    const status = readStatus(plan_id);
    if (!status) {
      return err(`Plan '${plan_id}' not found.`);
    }

    const phase = status.phases.find((p) => p.id === phase_id);
    if (!phase) {
      return err(`Phase ${phase_id} not found in plan.`);
    }

    // Check dependencies
    const unmet = phase.depends_on.filter((depId) => {
      const dep = status.phases.find((p) => p.id === depId);
      return !dep || dep.status !== "DONE";
    });

    if (unmet.length > 0) {
      const unmetNames = unmet
        .map((id) => {
          const p = status.phases.find((pp) => pp.id === id);
          return `Phase ${id} (${p?.name || "unknown"})`;
        })
        .join(", ");
      return err(
        `Cannot start Phase ${phase_id}: unmet dependencies: ${unmetNames}. Complete those first.`,
      );
    }

    if (phase.status === "IN_PROGRESS") {
      return ok(
        `Phase ${phase_id} is already IN_PROGRESS (started ${phase.started} by ${phase.agent || "unknown"}).`,
      );
    }

    if (phase.status === "DONE") {
      return ok(
        `Phase ${phase_id} is already DONE (completed ${phase.completed}).`,
      );
    }

    phase.status = "IN_PROGRESS";
    phase.agent = agent || null;
    phase.started = nowISO();
    writeStatus(plan_id, status);

    // Also update the phase doc header
    const doc = readPhaseDoc(plan_id, phase_id);
    if (doc) {
      const updated = doc
        .replace(/<!-- STATUS: .* -->/, `<!-- STATUS: IN_PROGRESS -->`)
        .replace(
          /<!-- AGENT: .* -->/,
          `<!-- AGENT: ${agent || "unknown"} -->`,
        );
      writePhaseDoc(plan_id, phase_id, updated);
    }

    const dir = resolvePlanDir(plan_id)!;

    // Build prerequisite output summary for cross-phase validation
    const depOutputs = phase.depends_on
      .map((depId) => {
        const dep = status.phases.find((p) => p.id === depId);
        if (!dep) return null;
        const outputs = dep.outputs?.length ? dep.outputs.join(", ") : "no declared outputs";
        const snapshot = dep.context_snapshot
          ? ` | Snapshot: ${JSON.stringify(dep.context_snapshot)}`
          : "";
        return `  Phase ${depId} (${dep.name}): ${outputs}${snapshot}`;
      })
      .filter(Boolean)
      .join("\n");

    const depSummary = depOutputs
      ? `\n\n## Prerequisite Outputs to Verify\n${depOutputs}`
      : "";

    // Return phase doc inline so the agent doesn't need a separate get_phase call
    const phaseDoc = readPhaseDoc(plan_id, phase_id);
    const inlineDoc = phaseDoc
      ? `\n\n${'─'.repeat(60)}\n## Phase ${phase_id} Instructions\n${'─'.repeat(60)}\n\n${phaseDoc}`
      : `\n\nPhase doc: ${phasePath(dir, phase_id)}`;

    return ok(
      `Phase ${phase_id} (${phase.name}) marked as IN_PROGRESS.\nStarted: ${phase.started}\nAgent: ${phase.agent || "not specified"}${depSummary}${inlineDoc}`,
    );
  },
);

// ── complete_phase ───────────────────────────────────────────────────────────

server.tool(
  "complete_phase",
  "Mark a phase as DONE. Records completion time and optional context snapshot. " +
    "Use when an agent has finished all steps, passed wiring checks, and confirmed clean git status. " +
    "Use when asking: I'm done with this phase, mark phase 2 as done, finish this phase. " +
    "Always call this after completing all steps and wiring checks. " +
    "If the phase has expected_counts or required_paths defined, completion will be REJECTED " +
    "if the context_snapshot values don't match or if required paths don't exist on disk.",
  {
    plan_id: z.string().describe("Plan ID"),
    phase_id: z.number().describe("Phase number to complete"),
    wiring_checks_passed: z
      .boolean()
      .optional()
      .describe(
        "Attestation that all wiring checks passed. If the phase has wiring_checks defined, " +
        "this MUST be set to true. Set to false or omit if checks have not been run.",
      ),
    context_snapshot: z
      .record(z.string(), z.union([z.string(), z.number()]))
      .optional()
      .describe(
        "Key-value snapshot of state after phase (e.g. { packages: 17, apps: 15, commits: 25 })",
      ),
    notes: z
      .string()
      .optional()
      .describe("Any notes or issues encountered during the phase"),
  },
  async ({ plan_id, phase_id, wiring_checks_passed, context_snapshot, notes }) => {
    const status = readStatus(plan_id);
    if (!status) {
      return err(`Plan '${plan_id}' not found.`);
    }

    const phase = status.phases.find((p) => p.id === phase_id);
    if (!phase) {
      return err(`Phase ${phase_id} not found in plan.`);
    }

    // ── Validation gates ──────────────────────────────────────────────────

    // Gate 1: Validate expected_counts against context_snapshot
    if (phase.expected_counts?.length) {
      if (!context_snapshot) {
        return err(
          `Cannot complete Phase ${phase_id}: this phase has expected_counts defined ` +
          `(${phase.expected_counts.map(e => e.key).join(', ')}) but no context_snapshot was provided. ` +
          `Call complete_phase with a context_snapshot that includes these keys.`,
        );
      }
      const failures = phase.expected_counts.filter(({ key, min, max }) => {
        const val = Number(context_snapshot[key]);
        return isNaN(val) || val < min || (max !== undefined && val > max);
      });
      if (failures.length > 0) {
        return err(
          `Cannot complete Phase ${phase_id}: context_snapshot values don't match expected_counts:\n` +
          failures
            .map((f) => {
              const got = context_snapshot[f.key];
              const range = f.max !== undefined ? `${f.min}-${f.max}` : `${f.min}+`;
              return `  ❌ ${f.key}: got ${got ?? 'missing'}, expected ${range}`;
            })
            .join('\n') +
          `\n\nFix the issues and try again, or update expected_counts if the plan changed.`,
        );
      }
    }

    // Gate 2: Validate required_paths exist on disk
    if (phase.required_paths?.length) {
      const dir = resolvePlanDir(plan_id)!;
      // Resolve paths relative to the plan directory's parent (typically the repo root)
      const repoRoot = dirname(dir);
      const missing = phase.required_paths.filter(
        (p) => !existsSync(isAbsolute(p) ? p : join(repoRoot, p)),
      );
      if (missing.length > 0) {
        return err(
          `Cannot complete Phase ${phase_id}: required paths missing:\n` +
          missing.map((p) => `  ❌ ${p}`).join('\n') +
          `\n\nEnsure these paths exist before completing the phase.`,
        );
      }
    }

    // Gate 3: Wiring checks attestation
    // Read the phase doc to check if wiring_checks were defined
    const phaseDoc = readPhaseDoc(plan_id, phase_id);
    const hasWiringChecks = phaseDoc?.includes('## Wiring Check') &&
      !phaseDoc?.includes('No wiring checks defined');
    if (hasWiringChecks && !wiring_checks_passed) {
      return err(
        `Cannot complete Phase ${phase_id}: this phase has wiring checks defined ` +
        `but wiring_checks_passed was not set to true. ` +
        `Run the wiring checks first, then call complete_phase with wiring_checks_passed: true.`,
      );
    }

    // ── All gates passed — mark as DONE ───────────────────────────────────

    phase.status = "DONE";
    phase.completed = nowISO();
    if (context_snapshot) phase.context_snapshot = context_snapshot;
    if (notes) phase.notes = notes;
    writeStatus(plan_id, status);

    // Update phase doc header
    const doc = readPhaseDoc(plan_id, phase_id);
    if (doc) {
      const updated = doc
        .replace(/<!-- STATUS: .* -->/, `<!-- STATUS: DONE -->`)
        .replace(
          /<!-- COMPLETED: .* -->/,
          `<!-- COMPLETED: ${phase.completed} -->`,
        );
      writePhaseDoc(plan_id, phase_id, updated);
    }

    // Check if all phases are done
    const allDone = status.phases.every((p) => p.status === "DONE");
    const nextPhase = status.phases.find(
      (p) =>
        p.status === "NOT_STARTED" &&
        p.depends_on.every((depId) => {
          const dep = status.phases.find((pp) => pp.id === depId);
          return dep && dep.status === "DONE";
        }),
    );

    const nextInfo = allDone
      ? "\n\n🎉 All phases complete! Plan is finished."
      : nextPhase
        ? `\n\nNext up: Phase ${nextPhase.id} (${nextPhase.name}). Use get_next_prompt("${plan_id}") to get the agent prompt.`
        : "\n\nNo eligible next phase (dependencies not met).";

    // Warn if no context snapshot provided
    const snapshotWarning = !context_snapshot
      ? "\n\n⚠️ No context_snapshot provided. The next agent session won't have state from this phase. " +
        "Consider calling complete_phase again with a context_snapshot (e.g. { files_created: 5, tests_passing: true }) " +
        "to help the next agent understand what was accomplished."
      : "";

    return ok(
      `Phase ${phase_id} (${phase.name}) marked as DONE.\nCompleted: ${phase.completed}${context_snapshot ? "\nSnapshot: " + JSON.stringify(context_snapshot) : ""}${notes ? "\nNotes: " + notes : ""}${snapshotWarning}${nextInfo}`,
    );
  },
);

// ── reset_phase ──────────────────────────────────────────────────────────────

server.tool(
  "reset_phase",
  "Reset a phase back to NOT_STARTED. Clears agent, timestamps, and any context snapshot. " +
    "Useful when an agent session died mid-phase or you need to re-execute a phase. " +
    "Use when asking: reset this phase, redo phase 2, restart this phase, " +
    "phase got stuck, clear the phase status.",
  {
    plan_id: z.string().describe("Plan ID"),
    phase_id: z.number().describe("Phase number to reset"),
  },
  async ({ plan_id, phase_id }) => {
    const status = readStatus(plan_id);
    if (!status) {
      return err(`Plan '${plan_id}' not found.`);
    }

    const phase = status.phases.find((p) => p.id === phase_id);
    if (!phase) {
      return err(`Phase ${phase_id} not found in plan.`);
    }

    if (phase.status === "NOT_STARTED") {
      return ok(`Phase ${phase_id} (${phase.name}) is already NOT_STARTED.`);
    }

    const previousStatus = phase.status;
    phase.status = "NOT_STARTED";
    phase.agent = null;
    phase.started = null;
    phase.completed = null;
    delete phase.context_snapshot;
    delete phase.notes;
    writeStatus(plan_id, status);

    // Update phase doc header
    const doc = readPhaseDoc(plan_id, phase_id);
    if (doc) {
      const updated = doc
        .replace(/<!-- STATUS: .* -->/, `<!-- STATUS: NOT_STARTED -->`)
        .replace(/<!-- AGENT: .* -->/, `<!-- AGENT: -->`)
        .replace(/<!-- COMPLETED: .* -->/, `<!-- COMPLETED: -->`);
      writePhaseDoc(plan_id, phase_id, updated);
    }

    return ok(
      `Phase ${phase_id} (${phase.name}) reset from ${previousStatus} to NOT_STARTED.\nAgent, timestamps, and snapshot cleared.`,
    );
  },
);

// ── get_next_prompt ──────────────────────────────────────────────────────────

server.tool(
  "get_next_prompt",
  "Get the pre-built prompt for the next agent session. " +
    "Finds the first phase whose dependencies are all DONE and that hasn't started yet, " +
    "then generates a prompt that includes context from completed phases. " +
    "Use when handing off to a new agent session, when asking: what's the next step, " +
    "start the next phase, generate a handoff prompt.",
  {
    plan_id: z.string().describe("Plan ID"),
  },
  async ({ plan_id }) => {
    const status = readStatus(plan_id);
    if (!status) {
      return err(`Plan '${plan_id}' not found.`);
    }

    const dir = resolvePlanDir(plan_id)!;
    const allDone = status.phases.every((p) => p.status === "DONE");
    if (allDone) {
      return ok(`All phases in '${plan_id}' are complete. No next prompt needed.`);
    }

    // Find next eligible phase
    const nextPhase = status.phases.find(
      (p) =>
        p.status === "NOT_STARTED" &&
        p.depends_on.every((depId) => {
          const dep = status.phases.find((pp) => pp.id === depId);
          return dep && dep.status === "DONE";
        }),
    );

    if (!nextPhase) {
      const inProgress = status.phases.find(
        (p) => p.status === "IN_PROGRESS",
      );
      if (inProgress) {
        return ok(
          `Phase ${inProgress.id} (${inProgress.name}) is currently IN_PROGRESS (started ${inProgress.started}). Complete it before getting the next prompt.`,
        );
      }
      return err("No eligible next phase. Some phases have unmet dependencies.");
    }

    // Build context from completed phases
    const completedPhases = status.phases.filter(
      (p) => p.status === "DONE",
    );
    const completedSummary = completedPhases
      .map((p) => {
        let line = `- Phase ${p.id} (${p.name}): DONE`;
        if (p.outputs?.length) line += ` — ${p.outputs.join(", ")}`;
        if (p.context_snapshot)
          line += ` | Snapshot: ${JSON.stringify(p.context_snapshot)}`;
        return line;
      })
      .join("\n");

    const prompt = `I'm executing Phase ${nextPhase.id} (${nextPhase.name}) of the plan "${status.title}".

Read these documents in order:
1. \`${statusPath(dir)}\` — current plan status
2. \`${phasePath(dir, nextPhase.id)}\` — my task for this phase

## Completed Phases

${completedSummary || "None — this is the first phase."}

## My Task

Phase ${nextPhase.id}: ${nextPhase.name}
${nextPhase.outputs?.length ? `Expected outputs: ${nextPhase.outputs.join(", ")}` : ""}

## Conventions

- Commit after each step: \`phase-${nextPhase.id}: <step description>\`
- Run all wiring checks before marking done
- Git status must be clean at end
- Use the phased-plan MCP tools: \`start_phase("${plan_id}", ${nextPhase.id})\` when beginning, \`complete_phase("${plan_id}", ${nextPhase.id})\` when done
`;

    return ok(
      `## Next Agent Prompt (Phase ${nextPhase.id}: ${nextPhase.name})\n\nCopy-paste this as the first message for the next agent session:\n\n---\n\n${prompt}\n---\n\nPhase doc location: ${phasePath(dir, nextPhase.id)}`,
    );
  },
);

// ── add_phase ────────────────────────────────────────────────────────────────

server.tool(
  "add_phase",
  "Add a new phase to an existing plan. Useful when you discover additional work " +
    "is needed mid-execution. The new phase is appended and its doc is generated. " +
    "Use when asking: add another phase, I need an extra step, this plan needs more work, " +
    "insert a new phase.",
  {
    plan_id: z.string().describe("Plan ID"),
    phase: z.object({
      id: z.number().describe("Phase number"),
      name: z.string(),
      goal: z.string(),
      depends_on: z.array(z.number()),
      steps: z.array(
        z.object({
          title: z.string(),
          instructions: z.string(),
        }),
      ),
      wiring_checks: z.array(z.string()).optional(),
      verification: z.array(z.string()).optional(),
      outputs: z.array(z.string()).optional(),
      context_snapshot: z.array(z.string()).optional(),
      expected_counts: z
        .array(z.object({
          key: z.string(),
          min: z.number(),
          max: z.number().optional(),
        }))
        .optional()
        .describe("Expected count ranges for context_snapshot values"),
      required_paths: z
        .array(z.string())
        .optional()
        .describe("Paths that must exist when phase completes"),
    }),
  },
  async ({ plan_id, phase }) => {
    const status = readStatus(plan_id);
    if (!status) {
      return err(`Plan '${plan_id}' not found.`);
    }

    if (status.phases.some((p) => p.id === phase.id)) {
      return err(`Phase ${phase.id} already exists in plan '${plan_id}'.`);
    }

    const dir = resolvePlanDir(plan_id)!;

    // Add to STATUS.json
    status.phases.push({
      id: phase.id,
      name: phase.name,
      file: phaseFilename(phase.id),
      status: "NOT_STARTED",
      agent: null,
      started: null,
      completed: null,
      depends_on: phase.depends_on,
      outputs: phase.outputs || [],
      ...(phase.expected_counts?.length ? { expected_counts: phase.expected_counts } : {}),
      ...(phase.required_paths?.length ? { required_paths: phase.required_paths } : {}),
    });

    status.phases.sort((a, b) => a.id - b.id);
    writeStatus(plan_id, status);

    // Generate phase doc using PhaseInput-compatible object
    const phaseInput: PhaseInput = {
      id: phase.id,
      name: phase.name,
      goal: phase.goal,
      depends_on: phase.depends_on,
      steps: phase.steps,
      wiring_checks: phase.wiring_checks,
      verification: phase.verification,
      outputs: phase.outputs,
      context_snapshot: phase.context_snapshot,
    };
    const allPhasesAsInput: PhaseInput[] = status.phases.map((p) => ({
      id: p.id,
      name: p.name,
      goal: "",
      depends_on: p.depends_on,
      steps: [],
    }));
    const doc = generatePhaseDoc(phaseInput, allPhasesAsInput, plan_id, dir);
    writeFileSync(phasePath(dir, phase.id), doc, "utf8");

    return ok(
      `Added Phase ${phase.id} (${phase.name}) to plan '${plan_id}'.\nDoc: ${phasePath(dir, phase.id)}`,
    );
  },
);

// ── update_phase_doc ─────────────────────────────────────────────────────────

server.tool(
  "update_phase_doc",
  "Replace the content of a phase document. Use when you need to refine the instructions " +
    "for a phase based on findings from a previous phase, or when the plan needs adjustment. " +
    "Use when asking: update the instructions, change the phase doc, revise phase 3, " +
    "edit the plan steps.",
  {
    plan_id: z.string().describe("Plan ID"),
    phase_id: z.number().describe("Phase number"),
    content: z
      .string()
      .describe("Full markdown content for the phase document"),
  },
  async ({ plan_id, phase_id, content }) => {
    const dir = resolvePlanDir(plan_id);
    if (!dir) {
      return err(`Plan '${plan_id}' not found.`);
    }

    const status = readStatus(plan_id);
    if (!status || !status.phases.some((p) => p.id === phase_id)) {
      return err(`Phase ${phase_id} not found in plan '${plan_id}'.`);
    }

    writeFileSync(phasePath(dir, phase_id), content, "utf8");

    return ok(`Updated phase doc: ${phasePath(dir, phase_id)}`);
  },
);

// ── delete_plan ──────────────────────────────────────────────────────────────

server.tool(
  "delete_plan",
  "Delete a plan from the global index and optionally remove its files from disk. " +
    "Use when a plan is finished and no longer needed, or was created by mistake. " +
    "Use when asking: delete this plan, remove the plan, clean up the plan, " +
    "I don't need this plan anymore.",
  {
    plan_id: z.string().describe("Plan ID to delete"),
    delete_files: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true, also delete the plan directory and all its files from disk. " +
          "If false (default), only removes the plan from the global index.",
      ),
  },
  async ({ plan_id, delete_files }) => {
    const dir = resolvePlanDir(plan_id);
    if (!dir) {
      return err(
        `Plan '${plan_id}' not found. Available: ${listPlanIds().join(", ") || "none"}`,
      );
    }

    // Remove from global index
    unregisterPlan(plan_id);

    // Optionally delete files
    if (delete_files && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      return ok(
        `Deleted plan '${plan_id}' and removed directory: ${dir}`,
      );
    }

    return ok(
      `Removed plan '${plan_id}' from the index. Files remain at: ${dir}`,
    );
  },
);

// ── plan_from_doc ────────────────────────────────────────────────────────────

server.tool(
  "plan_from_doc",
  "Read an implementation plan document and get structured guidance for decomposing it into " +
    "a phased execution plan. Returns the full document content plus instructions on how to " +
    "call create_plan with the right phase structure. " +
    "Typical workflow: (1) agent writes implementation_plan.md, (2) user approves it, " +
    "(3) agent calls plan_from_doc to get decomposition guidance, (4) agent calls create_plan. " +
    "Use when asking: convert this plan to phases, make this a phased plan, " +
    "split this implementation plan into executable phases.",
  {
    doc_path: z
      .string()
      .describe(
        "Absolute path to the implementation plan markdown file to read and decompose.",
      ),
    plan_id: z
      .string()
      .optional()
      .describe(
        "Suggested plan ID. If omitted, one will be suggested based on the doc filename.",
      ),
    plan_directory: z
      .string()
      .optional()
      .describe(
        "Absolute path where the phased plan should be created. " +
          "If omitted, will suggest creating it alongside the source document.",
      ),
  },
  async ({ doc_path, plan_id, plan_directory }) => {
    if (!isAbsolute(doc_path)) {
      return err(`doc_path must be an absolute path. Got: '${doc_path}'`);
    }

    let content: string;
    try {
      content = readFileSync(doc_path, "utf8");
    } catch (e) {
      return err(`Could not read file: ${doc_path}. Error: ${(e as Error).message}`);
    }

    const suggestedId =
      plan_id ||
      doc_path
        .split("/")
        .pop()
        ?.replace(/\.md$/, "")
        .replace(/[^a-z0-9]+/gi, "-")
        .toLowerCase() ||
      "my-plan";

    const suggestedDir =
      plan_directory || join(dirname(doc_path), suggestedId);

    return ok(
      `# Implementation Plan Document

**Source:** \`${doc_path}\`
**Suggested plan_id:** \`${suggestedId}\`
**Suggested directory:** \`${suggestedDir}\`

---

## Document Content

${content}

---

## Decomposition Instructions

Now call \`create_plan\` to convert this into a phased execution plan. Follow these guidelines:

### Phase Structure Best Practices

1. **Phase 0 — Pre-flight checks**: Verify environment, dependencies, clean git status
2. **Middle phases**: One phase per logical unit of work that can be completed in a single agent session (~30-60 min of work)
3. **Final phase — Verification**: End-to-end validation, smoke tests, cleanup

### Phase Boundary Heuristics

Split phases at natural boundaries where:
- A \`git commit\` marks a stable checkpoint
- The next step has different prerequisites than the current step
- A different agent session should pick up (e.g., after a long build)
- The work shifts from one component/concern to another

### Required Fields for Each Phase

\`\`\`json
{
  "id": 0,
  "name": "Phase Name",
  "goal": "One-sentence goal",
  "depends_on": [],
  "steps": [
    {
      "title": "Step title",
      "instructions": "Detailed markdown instructions with bash commands, file contents, etc."
    }
  ],
  "wiring_checks": ["Check X is true", "Check Y exists"],
  "verification": ["Verify A works", "Verify B passes"],
  "outputs": ["What this phase produces for the next phase"],
  "context_snapshot": ["echo \\"key: $(command)\\""],
  "expected_counts": [
    { "key": "snapshot_key", "min": 5, "max": 10 }
  ],
  "required_paths": ["relative/path/that/must/exist"]
}
\`\`\`

### Guardrail Fields (recommended)

- **\`expected_counts\`**: Define min/max ranges for numeric values in context_snapshot. \`complete_phase\` will REJECT completion if values fall outside these ranges.
- **\`required_paths\`**: Paths that must exist on disk when the phase completes. Use absolute paths if the plan directory is not inside the repo.
- **\`wiring_checks\`**: Things agents commonly forget to connect — the agent must attest these passed before completing.

### Call create_plan

\`\`\`
create_plan({
  plan_id: "${suggestedId}",
  directory: "${suggestedDir}",
  title: "...",
  description: "...",
  phases: [...]
})
\`\`\`
`,
    );
  },
);

// ── Transport ────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
