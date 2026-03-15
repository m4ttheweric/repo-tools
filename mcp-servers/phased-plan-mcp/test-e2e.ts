/**
 * E2E test for phased-plan-mcp — exercises the full plan lifecycle
 * using the MCP SDK Client for proper protocol handling.
 *
 * Run: bun test-e2e.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// ── Test helpers ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

function section(name: string): void {
  console.log(`\n── ${name} ${"─".repeat(60 - name.length)}`);
}

// ── Index helpers (to verify side effects) ───────────────────────────────────

const INDEX_DIR = join(process.env.HOME || "/tmp", ".phased-plans");
const INDEX_PATH = join(INDEX_DIR, "index.json");

interface PlanIndex {
  [planId: string]: { directory: string; registered: string };
}

interface PhaseEntry {
  id: number;
  name: string;
  status: string;
  agent: string | null;
  started: string | null;
  completed: string | null;
  context_snapshot?: Record<string, string | number>;
}

interface PlanStatus {
  plan_id: string;
  phases: PhaseEntry[];
}

function readIndex(): PlanIndex {
  try {
    return JSON.parse(readFileSync(INDEX_PATH, "utf8")) as PlanIndex;
  } catch {
    return {};
  }
}

// ── MCP client ───────────────────────────────────────────────────────────────

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return {
    text: content?.[0]?.text || "",
    isError: result.isError === true,
  };
}

// ── Run tests ────────────────────────────────────────────────────────────────

const TEST_PLAN_ID = `test-e2e-${Date.now()}`;
const testDir = mkdtempSync(join("/tmp", "phased-plan-test-"));

async function runTests() {
  console.log("🧪 Phased Plan MCP — E2E Test");
  console.log(`   Plan ID: ${TEST_PLAN_ID}`);
  console.log(`   Test dir: ${testDir}`);

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", join(import.meta.dirname!, "server.ts")],
  });

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);

  try {
    // ── Create Plan ──────────────────────────────────────────────────────
    section("create_plan");

    const createResult = await callTool(client, "create_plan", {
      plan_id: TEST_PLAN_ID,
      directory: testDir,
      title: "E2E Test Plan",
      description: "Testing all MCP tools",
      phases: [
        {
          id: 0,
          name: "First Phase",
          goal: "Test phase 0",
          depends_on: [],
          steps: [{ title: "Step A", instructions: "Do step A" }],
        },
        {
          id: 1,
          name: "Second Phase",
          goal: "Test phase 1",
          depends_on: [0],
          steps: [{ title: "Step B", instructions: "Do step B" }],
        },
      ],
    });

    assert(!createResult.isError, `create_plan succeeds (${createResult.isError ? createResult.text.slice(0, 200) : "ok"})`);
    assert(existsSync(join(testDir, "STATUS.json")), "STATUS.json created");
    assert(existsSync(join(testDir, "phase-0.md")), "phase-0.md created");
    assert(existsSync(join(testDir, "phase-1.md")), "phase-1.md created");
    assert(existsSync(join(testDir, "README.md")), "README.md created");

    // ── Directory Validation ─────────────────────────────────────────────
    section("create_plan validation");

    const badDir = await callTool(client, "create_plan", {
      plan_id: "bad-plan",
      directory: "relative/path",
      title: "Bad Plan",
      description: "Should fail",
      phases: [],
    });
    assert(badDir.isError, "Rejects relative directory path");

    // ── List Plans ───────────────────────────────────────────────────────
    section("list_plans");

    const listResult = await callTool(client, "list_plans");
    assert(listResult.text.includes(TEST_PLAN_ID), "Plan appears in list");

    // ── Get Plan Status ──────────────────────────────────────────────────
    section("get_plan_status");

    const statusResult = await callTool(client, "get_plan_status", {
      plan_id: TEST_PLAN_ID,
    });
    assert(statusResult.text.includes("NOT_STARTED"), "Phases start as NOT_STARTED");

    // ── Get Phase ────────────────────────────────────────────────────────
    section("get_phase");

    const phaseResult = await callTool(client, "get_phase", {
      plan_id: TEST_PLAN_ID,
      phase_id: 0,
    });
    assert(phaseResult.text.includes("First Phase"), "Phase 0 doc contains name");
    assert(phaseResult.text.includes("Step A"), "Phase 0 doc contains step");

    // ── Start Phase ──────────────────────────────────────────────────────
    section("start_phase");

    const startResult = await callTool(client, "start_phase", {
      plan_id: TEST_PLAN_ID,
      phase_id: 0,
      agent: "test-agent",
    });
    assert(!startResult.isError, "start_phase succeeds");

    const afterStart = JSON.parse(readFileSync(join(testDir, "STATUS.json"), "utf8")) as PlanStatus;
    assert(afterStart.phases[0].status === "IN_PROGRESS", "Phase 0 is IN_PROGRESS");
    assert(afterStart.phases[0].agent === "test-agent", "Agent recorded");

    // ── Start Phase with unmet deps ──────────────────────────────────────
    const unmetResult = await callTool(client, "start_phase", {
      plan_id: TEST_PLAN_ID,
      phase_id: 1,
    });
    assert(unmetResult.isError, "Cannot start phase 1 with unmet deps");

    // ── Complete Phase ───────────────────────────────────────────────────
    section("complete_phase");

    const completeResult = await callTool(client, "complete_phase", {
      plan_id: TEST_PLAN_ID,
      phase_id: 0,
      context_snapshot: { tests: 5 },
      notes: "E2E test note",
    });
    assert(!completeResult.isError, "complete_phase succeeds");

    const afterComplete = JSON.parse(readFileSync(join(testDir, "STATUS.json"), "utf8")) as PlanStatus;
    assert(afterComplete.phases[0].status === "DONE", "Phase 0 is DONE");

    // ── Reset Phase ──────────────────────────────────────────────────────
    section("reset_phase");

    const resetResult = await callTool(client, "reset_phase", {
      plan_id: TEST_PLAN_ID,
      phase_id: 0,
    });
    assert(!resetResult.isError, "reset_phase succeeds");

    const afterReset = JSON.parse(readFileSync(join(testDir, "STATUS.json"), "utf8")) as PlanStatus;
    assert(afterReset.phases[0].status === "NOT_STARTED", "Phase 0 reset to NOT_STARTED");
    assert(afterReset.phases[0].agent === null, "Agent cleared");

    // ── Get Next Prompt ──────────────────────────────────────────────────
    section("get_next_prompt");

    const promptResult = await callTool(client, "get_next_prompt", {
      plan_id: TEST_PLAN_ID,
    });
    assert(promptResult.text.includes("Phase 0"), "Next prompt targets Phase 0");

    // ── Add Phase ────────────────────────────────────────────────────────
    section("add_phase");

    const addResult = await callTool(client, "add_phase", {
      plan_id: TEST_PLAN_ID,
      phase: {
        id: 2,
        name: "Third Phase",
        goal: "Test adding phases",
        depends_on: [1],
        steps: [{ title: "Step C", instructions: "Do step C" }],
      },
    });
    assert(!addResult.isError, "add_phase succeeds");
    assert(existsSync(join(testDir, "phase-2.md")), "phase-2.md created");

    const afterAdd = JSON.parse(readFileSync(join(testDir, "STATUS.json"), "utf8")) as PlanStatus;
    assert(afterAdd.phases.length === 3, "Plan now has 3 phases");

    // ── Update Phase Doc ─────────────────────────────────────────────────
    section("update_phase_doc");

    const updateResult = await callTool(client, "update_phase_doc", {
      plan_id: TEST_PLAN_ID,
      phase_id: 2,
      content: "# Updated Phase 2\n\nCustom content.",
    });
    assert(!updateResult.isError, "update_phase_doc succeeds");

    const updatedDoc = readFileSync(join(testDir, "phase-2.md"), "utf8");
    assert(updatedDoc.includes("Custom content"), "Phase doc content updated");

    // ── Delete Plan ──────────────────────────────────────────────────────
    section("delete_plan");

    const deleteResult = await callTool(client, "delete_plan", {
      plan_id: TEST_PLAN_ID,
      delete_files: true,
    });
    assert(!deleteResult.isError, "delete_plan succeeds");

    const indexAfterDelete = readIndex();
    assert(!(TEST_PLAN_ID in indexAfterDelete), "Plan removed from index");
    assert(!existsSync(testDir), "Plan directory deleted");

  } finally {
    await client.close();
    // Cleanup in case test failed before delete_plan
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    const index = readIndex();
    if (TEST_PLAN_ID in index) {
      delete index[TEST_PLAN_ID];
      if (!existsSync(INDEX_DIR)) mkdirSync(INDEX_DIR, { recursive: true });
      writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + "\n", "utf8");
    }
  }

  console.log(`\n${"═".repeat(65)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`${"═".repeat(65)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
