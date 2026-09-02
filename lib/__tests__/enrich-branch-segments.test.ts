/**
 * formatBranchSegments is the picker's segment-form sibling of
 * formatBranchLabelParts: same source fields, but tones/hex instead of ANSI
 * escapes. These are golden tests against the glyph vocabulary in
 * docs/design/picker/Enrichment.dc.html.
 */

import { describe, expect, test } from "bun:test";
import { formatBranchSegments, type EnrichedBranch, type MRInfo } from "../enrich.ts";
import type { LinearTicket } from "../linear.ts";

function mkTicket(overrides: Partial<LinearTicket> = {}): LinearTicket {
  return {
    id: "t1",
    identifier: "ACME-1234",
    title: "Claim chat sidebar",
    description: null,
    url: "https://linear.app/x/issue/ACME-1234",
    stateName: "In Progress",
    stateColor: null,
    branchName: null,
    ...overrides,
  };
}

function mkMr(overrides: Partial<MRInfo> = {}): MRInfo {
  return {
    provider: "gitlab",
    iid: 1,
    title: "MR title",
    webUrl: null,
    state: "opened",
    isDraft: false,
    author: { id: "u1", name: "a", avatarUrl: null } as any,
    assignees: [],
    createdAt: null,
    sourceBranch: "feature",
    targetBranch: "main",
    behindTarget: null,
    diff: null,
    pipeline: null,
    reviews: [] as any,
    sha: "abc123",
    ...overrides,
  } as MRInfo;
}

function mkBranch(overrides: Partial<EnrichedBranch> = {}): EnrichedBranch {
  return {
    path: "/repo/wt",
    dirName: "wt",
    branch: "feature-x",
    linearId: null,
    ticket: null,
    mr: null,
    ...overrides,
  };
}

describe("formatBranchSegments", () => {
  test("ticket branch with a Linear stateColor rides as hex, not a tone", () => {
    const eb = mkBranch({
      dirName: "neville",
      linearId: "ACME-1234",
      ticket: mkTicket({ stateName: "Done", stateColor: "#4CB782" }),
    });
    const { left } = formatBranchSegments(eb);

    expect(left).toEqual([
      { text: "neville", tone: "text", bold: true },
      { text: " · ", tone: "faint" },
      { text: "Claim chat sidebar", tone: "text", bold: true },
      { text: " [Done]", hex: "#4CB782" },
    ]);
  });

  test("ticket branch with no stateColor falls back to the dim tone", () => {
    const eb = mkBranch({
      linearId: "ACME-1234",
      ticket: mkTicket({ stateName: "Backlog", stateColor: null }),
    });
    const { left } = formatBranchSegments(eb);
    expect(left.at(-1)).toEqual({ text: " [Backlog]", tone: "dim" });
  });

  test("non-ticket branch with no MR/ticket/linearId is [Local Only], dimmer", () => {
    const eb = mkBranch({ dirName: "gitq-1", branch: "on-deck/bill" });
    const { left, right } = formatBranchSegments(eb);

    expect(left).toEqual([
      { text: "gitq-1", tone: "text", bold: true },
      { text: " · ", tone: "faint" },
      { text: "on-deck/bill", tone: "dim" },
    ]);
    expect(right).toEqual([{ text: "[Local Only]", tone: "dimmer" }]);
  });

  test("a bare worktree with no branch renders dirName only", () => {
    const eb = mkBranch({ dirName: "gitq-1", branch: "" });
    const { left } = formatBranchSegments(eb);
    expect(left).toEqual([{ text: "gitq-1", tone: "text", bold: true }]);
  });

  test("default branch with no MR/ticket/linearId is [main branch], dimmer", () => {
    const eb = mkBranch({ dirName: "harbor", branch: "main" });
    const { right } = formatBranchSegments(eb);
    expect(right).toEqual([{ text: "[main branch]", tone: "dimmer" }]);
  });

  test("default branch WITH icons never shows the [main branch] tag", () => {
    const eb = mkBranch({
      dirName: "harbor",
      branch: "master",
      mr: mkMr({ state: "closed", pipeline: { status: "success" } as any }),
    });
    const { right } = formatBranchSegments(eb);
    expect(right).toEqual([
      { text: "✓", tone: "mint" },
      { text: " " },
      { text: "○", tone: "coral" },
    ]);
  });

  test("pipeline + MR-state icon glyph/tone vocabulary", () => {
    const cases: Array<[string, string, string]> = [
      ["success", "✓", "mint"],
      ["success_with_warnings", "✓", "peach"],
      ["failed", "✗", "coral"],
      ["running", "⟳", "cyan"],
      ["pending", "⟳", "faint"],
      ["created", "○", "faint"],
      ["canceled", "✗", "faint"],
    ];
    for (const [status, glyph, tone] of cases) {
      const eb = mkBranch({ mr: mkMr({ state: "opened", pipeline: { status } as any }) });
      const { right } = formatBranchSegments(eb);
      expect(right[0]).toEqual({ text: glyph, tone });
    }

    const mrCases: Array<[string, string, string]> = [
      ["opened", "◉", "mint"],
      ["merged", "●", "blue"],
      ["closed", "○", "coral"],
    ];
    for (const [state, glyph, tone] of mrCases) {
      const eb = mkBranch({ mr: mkMr({ state: state as any, pipeline: null }) });
      const { right } = formatBranchSegments(eb);
      expect(right[0]).toEqual({ text: glyph, tone });
    }
  });

  test("non-ticket branch with only a linearId (no MR) shows it dimmer, right-pinned", () => {
    const eb = mkBranch({ dirName: "hedwig", branch: "acme-token-pipeline", linearId: "ACME-1234" });
    const { right } = formatBranchSegments(eb);
    expect(right).toEqual([{ text: "ACME-1234", tone: "dimmer" }]);
  });

  test("icons AND a linearId (no ticket) both appear, space-joined", () => {
    const eb = mkBranch({
      dirName: "hedwig",
      branch: "acme-token-pipeline",
      linearId: "ACME-1234",
      mr: mkMr({ state: "opened", pipeline: { status: "running" } as any }),
    });
    const { right } = formatBranchSegments(eb);
    expect(right).toEqual([
      { text: "⟳", tone: "cyan" },
      { text: " " },
      { text: "◉", tone: "mint" },
      { text: " " },
      { text: "ACME-1234", tone: "dimmer" },
    ]);
  });
});
