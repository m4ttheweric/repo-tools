import { describe, test, expect, afterEach } from "bun:test";
import { pickStartedState, fetchMyTodoTickets, searchTickets } from "../linear.ts";

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

/** Stub global.fetch to return canned GraphQL data and capture the request body. */
function mockGraphql(data: unknown): { body: () => { query: string; variables: Record<string, unknown> } } {
  let captured: { query: string; variables: Record<string, unknown> } | null = null;
  global.fetch = (async (_url: string, init: { body: string }) => {
    captured = JSON.parse(init.body);
    return { ok: true, json: async () => ({ data }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { body: () => captured! };
}

const node = (identifier: string, stateName: string | null = "Todo") => ({
  id: identifier.toLowerCase(),
  identifier,
  title: `${identifier} title`,
  description: null,
  url: `https://linear.app/issue/${identifier}`,
  branchName: null,
  state: stateName ? { name: stateName, color: "#fff" } : null,
});

describe("pickStartedState", () => {
  // Reproduces the Acme (Derpy) team: many `started`-type states, where the
  // API returns "Ready for Merge" first but "In Progress" (position 0) is the
  // real entry point into the started group.
  const acmeStates = [
    { id: "merge", type: "started", position: 4000 },
    { id: "stale", type: "canceled", position: 0 },
    { id: "ready-testing", type: "started", position: 2000 },
    { id: "code-review", type: "started", position: 1000 },
    { id: "in-progress", type: "started", position: 0 },
    { id: "todo", type: "unstarted", position: 0 },
    { id: "done", type: "completed", position: 0 },
  ];

  test("picks the lowest-position started state, not the first in the array", () => {
    expect(pickStartedState(acmeStates)?.id).toBe("in-progress");
  });

  test("returns null when there is no started state", () => {
    expect(
      pickStartedState([
        { id: "todo", type: "unstarted", position: 0 },
        { id: "done", type: "completed", position: 1000 },
      ]),
    ).toBeNull();
  });

  test("falls back to the single started state when only one exists", () => {
    expect(
      pickStartedState([
        { id: "backlog", type: "backlog", position: 0 },
        { id: "doing", type: "started", position: 500 },
      ])?.id,
    ).toBe("doing");
  });
});

describe("fetchMyTodoTickets", () => {
  // Regression: the branch picker once fetched the whole team's active backlog
  // capped at 50 (no assignee filter), so a user's own older ticket (e.g.
  // ACME-2256, last touched a day ago) fell off behind the team's churn. The
  // query must scope to the viewer's own assigned tickets.
  test("scopes to the viewer's own assigned tickets, not the whole team backlog", async () => {
    const m = mockGraphql({ team: { issues: { nodes: [node("ACME-2256")] } } });

    const tickets = await fetchMyTodoTickets("key", "team-123");

    const sent = m.body();
    expect(sent.query).toContain("assignee");
    expect(sent.query).toContain("isMe");
    expect(sent.variables.teamId).toBe("team-123");
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.identifier).toBe("ACME-2256");
  });

  test("returns [] when the API errors", async () => {
    global.fetch = (async () => ({ ok: false, status: 500 }) as unknown as Response) as unknown as typeof fetch;
    expect(await fetchMyTodoTickets("key", "team-123")).toEqual([]);
  });
});

describe("searchTickets", () => {
  test("maps searchIssues results, preserving order", async () => {
    const m = mockGraphql({ searchIssues: { nodes: [node("ACME-2256"), node("EM-2256", null)] } });

    const tickets = await searchTickets("key", "2256");

    expect(m.body().variables.term).toBe("2256");
    expect(tickets.map((t) => t.identifier)).toEqual(["ACME-2256", "EM-2256"]);
    expect(tickets[1]!.stateName).toBeNull();
  });

  test("returns [] without hitting the network for blank terms", async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return { ok: true, json: async () => ({ data: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;

    expect(await searchTickets("key", "   ")).toEqual([]);
    expect(called).toBe(false);
  });
});
