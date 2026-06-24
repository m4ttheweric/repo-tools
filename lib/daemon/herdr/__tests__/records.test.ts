import { describe, test, expect } from "bun:test";
import { paneToRecord, herdrAgentStatusToState, type HerdrPane } from "../records.ts";

const wt = [{ repo: "acme-dev", path: "/repo/wt2", branch: "parking-lot/2" }];
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
    expect(r.repo).toBe("acme-dev");
    expect(r.worktree).toBe("/repo/wt2");
    expect(r.branch).toBe("parking-lot/2");
    expect(r.state).toBe("running");
  });
});
