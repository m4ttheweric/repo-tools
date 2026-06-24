import { describe, test, expect } from "bun:test";
import { paneToRecord, herdrAgentStatusToState, type HerdrPane } from "../records.ts";

const wt = [{ repo: "assured-dev", path: "/repo/wt2", branch: "parking-lot/2" }];
const pane = (o: Partial<HerdrPane> = {}): HerdrPane => ({
  paneId: "w3:p1", terminalId: "term_a", workspaceId: "w3",
  cwd: "/repo/wt2/apps/backend", agentStatus: "working", foregroundCmd: "node server.js", ...o,
});

describe("herdrAgentStatusToState", () => {
  test("maps herdr statuses to ProcessState", () => {
    expect(herdrAgentStatusToState("working")).toBe("running");
    expect(herdrAgentStatusToState("done")).toBe("stopped");
    expect(herdrAgentStatusToState("idle")).toBe("stopped");
    expect(herdrAgentStatusToState("blocked")).toBe("running");
    expect(herdrAgentStatusToState("unknown")).toBe("running");
  });
});

describe("paneToRecord", () => {
  test("uses the map ref's rt id + cmd when present, else herdr ids", () => {
    const withRef = paneToRecord(pane(), { id: "backend:start", workspaceId:"w3", paneId:"w3:p1", terminalId:"term_a", cwd:"/repo/wt2/apps/backend", cmd:"pnpm start", startedAt: 5 }, wt);
    expect(withRef.id).toBe("backend:start");
    expect(withRef.cmd).toBe("pnpm start");
    const noRef = paneToRecord(pane(), undefined, wt);
    expect(noRef.id).toBe("term_a");
    expect(noRef.cmd).toBe("node server.js");
  });
  test("enriches with the worktree the cwd maps to", () => {
    const r = paneToRecord(pane(), undefined, wt);
    expect(r.repo).toBe("assured-dev");
    expect(r.worktree).toBe("/repo/wt2");
    expect(r.branch).toBe("parking-lot/2");
    expect(r.state).toBe("running");
  });
  test("threads kind through from the ref to the record", () => {
    const ref = { id: "shell:1", workspaceId: "w3", paneId: "w3:p1", terminalId: "term_a",
      cwd: "/repo/wt2/apps/backend", cmd: "zsh", startedAt: 0, kind: "terminal" as const };
    const r = paneToRecord(pane(), ref, wt);
    expect(r.kind).toBe("terminal");
  });
  test("kind is undefined when ref carries no kind", () => {
    const ref = { id: "backend:start", workspaceId: "w3", paneId: "w3:p1", terminalId: "term_a",
      cwd: "/repo/wt2/apps/backend", cmd: "pnpm start", startedAt: 5 };
    const r = paneToRecord(pane(), ref, wt);
    expect(r.kind).toBeUndefined();
  });
  test("kind is undefined when ref is absent", () => {
    const r = paneToRecord(pane(), undefined, wt);
    expect(r.kind).toBeUndefined();
  });
});
