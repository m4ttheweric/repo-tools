import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { LinearTicket } from "../linear.ts";

const origHome = process.env.HOME;
const TMP = "/tmp/branch-naming-test-home";

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  process.env.HOME = TMP;
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(TMP, { recursive: true, force: true });
});

const sampleTicket: LinearTicket = {
  id: "abc-123",
  identifier: "ACME-1287",
  title: "Add damage photos to claim view",
  description: null,
  url: "https://linear.app/issue/ACME-1287",
  stateName: "In Progress",
  stateColor: "#6b6bff",
  branchName: "feature/acme-1287-add-damage-photos",
};

describe("loadBranchNamingConfig", () => {
  test("returns null when config file does not exist", async () => {
    const { loadBranchNamingConfig } = await import("../branch-naming.ts");
    const dataDir = join(TMP, "nonexistent");
    expect(loadBranchNamingConfig(dataDir)).toBeNull();
  });

  test("loads config when file exists", async () => {
    const { loadBranchNamingConfig } = await import("../branch-naming.ts");
    const dataDir = join(TMP, "repo");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "branch-naming.json"),
      JSON.stringify({ template: "${teamPrefix}-${ticketNumber}-${llmSlug:10}" }),
    );
    const config = loadBranchNamingConfig(dataDir);
    expect(config).not.toBeNull();
    expect(config!.template).toBe("${teamPrefix}-${ticketNumber}-${llmSlug:10}");
  });

  test("returns null for malformed JSON", async () => {
    const { loadBranchNamingConfig } = await import("../branch-naming.ts");
    const dataDir = join(TMP, "bad-repo");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "branch-naming.json"), "not json");
    expect(loadBranchNamingConfig(dataDir)).toBeNull();
  });

  test("returns null for empty/missing template field", async () => {
    const { loadBranchNamingConfig } = await import("../branch-naming.ts");
    const dataDir = join(TMP, "empty-repo");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "branch-naming.json"),
      JSON.stringify({}),
    );
    expect(loadBranchNamingConfig(dataDir)).toBeNull();
  });

  test("returns null for whitespace-only template", async () => {
    const { loadBranchNamingConfig } = await import("../branch-naming.ts");
    const dataDir = join(TMP, "ws-repo");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "branch-naming.json"),
      JSON.stringify({ template: "   " }),
    );
    expect(loadBranchNamingConfig(dataDir)).toBeNull();
  });
});

describe("resolveBranchName", () => {
  test("fallback: produces identifier-titleSlug when config is null", async () => {
    const { resolveBranchName } = await import("../branch-naming.ts");
    const name = await resolveBranchName(sampleTicket, null);
    expect(name).toBe("acme-1287-add-damage-photos-to-claim-view");
  });

  test("resolves ${identifier} and ${titleSlug}", async () => {
    const { resolveBranchName } = await import("../branch-naming.ts");
    const name = await resolveBranchName(sampleTicket, {
      template: "${identifier}-${titleSlug}",
    });
    expect(name).toBe("acme-1287-add-damage-photos-to-claim-view");
  });

  test("resolves ${teamPrefix}", async () => {
    const { resolveBranchName } = await import("../branch-naming.ts");
    const name = await resolveBranchName(sampleTicket, {
      template: "${teamPrefix}",
    });
    expect(name).toBe("cv");
  });

  test("resolves ${ticketNumber}", async () => {
    const { resolveBranchName } = await import("../branch-naming.ts");
    const name = await resolveBranchName(sampleTicket, {
      template: "${ticketNumber}",
    });
    expect(name).toBe("1287");
  });

  test("combines multiple vars", async () => {
    const { resolveBranchName } = await import("../branch-naming.ts");
    const name = await resolveBranchName(sampleTicket, {
      template: "${teamPrefix}-${ticketNumber}-${titleSlug}",
    });
    expect(name).toBe("acme-1287-add-damage-photos-to-claim-view");
  });

  test("uses directory separators in template", async () => {
    const { resolveBranchName } = await import("../branch-naming.ts");
    const name = await resolveBranchName(sampleTicket, {
      template: "${teamPrefix}/${ticketNumber}/${titleSlug}",
    });
    expect(name).toBe("cv/1287/add-damage-photos-to-claim-view");
  });

  test("strips leading/trailing slashes from resolved name", async () => {
    const { resolveBranchName } = await import("../branch-naming.ts");
    const name = await resolveBranchName(sampleTicket, {
      template: "/${identifier}/",
    });
    expect(name).toBe("acme-1287");
  });

  test("rejects unknown variable names", async () => {
    const { resolveBranchName } = await import("../branch-naming.ts");
    await expect(
      resolveBranchName(sampleTicket, { template: "${badVar}" }),
    ).rejects.toThrow("Unknown variable");
  });

  test("rejects ${llmSlug} with no N", async () => {
    const { resolveBranchName } = await import("../branch-naming.ts");
    await expect(
      resolveBranchName(sampleTicket, { template: "${llmSlug}" }),
    ).rejects.toThrow("${llmSlug}");
  });

  test("rejects ${llmSlug} with non-integer N", async () => {
    const { resolveBranchName } = await import("../branch-naming.ts");
    await expect(
      resolveBranchName(sampleTicket, { template: "${llmSlug:abc}" }),
    ).rejects.toThrow("${llmSlug}");
  });

  test("falls back to mechanical slug when llmSlug errors", async () => {
    // We'll test this by making the LLM unavailable ($~/.mattstack/rt/llm.json won't
    // exist, so the model is ""), which causes llmPrompt to fail with
    // LlmUnavailableError. resolveBranchName should catch and use a
    // truncated mechanical slug instead.
    const { resolveBranchName } = await import("../branch-naming.ts");
    const name = await resolveBranchName(sampleTicket, {
      template: "${llmSlug:10}",
    });
    // Should be a mechanical slug truncated to 10 chars
    expect(name.length).toBeLessThanOrEqual(10);
    expect(name).not.toBe("");
    expect(name).toMatch(/^[a-z0-9-]+$/);
  });
});
