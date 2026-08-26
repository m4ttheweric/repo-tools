import { describe, expect, test } from "bun:test";
import { fetchTicketsBatch, LinearGraphqlError } from "../linear.ts";

/**
 * Linear answers a batched alias query with HTTP 200, an `errors` array and an
 * EMPTY `data` payload as soon as any single alias names an issue it cannot
 * resolve — a deleted ticket, or one the key cannot see. One dead id therefore
 * takes every other ticket in the batch down with it, which on this machine
 * left all 203 cached ids resolving to null.
 *
 * A transport failure (timeout, 5xx, 401, 429) looks nothing like that and must
 * NOT be read as "these ids are gone": `enrichBranches` preserves its cached
 * tickets only while this function rejects, so swallowing an outage is what
 * would overwrite good tickets with null.
 */
const ticket = (id: string) => ({
  id: `uuid-${id}`,
  identifier: id,
  title: `title ${id}`,
  url: `https://linear.app/acme/issue/${id}`,
  state: { name: "In Progress", color: "#fff" },
});

/** Stands in for Linear: any batch containing a dead id resolves nothing. */
function fakeGraphql(dead: Set<string>, transportFailure?: Error) {
  const calls: string[][] = [];
  const run = async (_key: string, query: string) => {
    const ids = [...query.matchAll(/issue\(id: "([^"]+)"\)/g)].map(m => m[1]!);
    calls.push(ids);
    if (transportFailure) throw transportFailure;
    if (ids.some(id => dead.has(id))) {
      throw new LinearGraphqlError([{ message: "Entity not found: Issue" }]);
    }
    const data: Record<string, unknown> = {};
    ids.forEach((id, i) => { data[`i${i}`] = ticket(id); });
    return data;
  };
  return { run, calls };
}

describe("fetchTicketsBatch survives an unresolvable id", () => {
  test("resolves every live ticket even when one id in the batch is dead", async () => {
    const { run } = fakeGraphql(new Set(["ACME-2"]));
    const got = await fetchTicketsBatch("key", ["ACME-1", "ACME-2", "ACME-3"], run);
    expect([...got.keys()].sort()).toEqual(["ACME-1", "ACME-3"]);
  });

  test("a wholly live batch still costs exactly one query", async () => {
    const { run, calls } = fakeGraphql(new Set());
    const got = await fetchTicketsBatch("key", ["ACME-1", "ACME-2", "ACME-3"], run);
    expect(got.size).toBe(3);
    expect(calls).toHaveLength(1);
  });

  test("isolating one dead id does not degrade to one query per id", async () => {
    const ids = Array.from({ length: 16 }, (_, i) => `ACME-${i}`);
    const { run, calls } = fakeGraphql(new Set(["ACME-9"]));
    const got = await fetchTicketsBatch("key", ids, run);
    expect(got.size).toBe(15);
    // Halving isolates the bad id; a per-id fallback would be 16+ calls.
    expect(calls.length).toBeLessThan(12);
  });

  test("all ids dead resolves nothing without throwing", async () => {
    const { run } = fakeGraphql(new Set(["ACME-1", "ACME-2"]));
    const got = await fetchTicketsBatch("key", ["ACME-1", "ACME-2"], run);
    expect(got.size).toBe(0);
  });
});

describe("fetchTicketsBatch rejects rather than mistake an outage for dead ids", () => {
  test("a timeout rejects instead of resolving empty", async () => {
    const { run } = fakeGraphql(new Set(), new DOMException("The operation timed out.", "TimeoutError"));
    await expect(fetchTicketsBatch("key", ["ACME-1", "ACME-2"], run)).rejects.toThrow(/timed out/i);
  });

  test("a non-200 response rejects", async () => {
    const { run } = fakeGraphql(new Set(), new Error("Linear API 503"));
    await expect(fetchTicketsBatch("key", ["ACME-1", "ACME-2"], run)).rejects.toThrow("Linear API 503");
  });

  test("a rate limit rejects rather than halving into per-id drops", async () => {
    const { run, calls } = fakeGraphql(new Set(), new Error("Linear API 429"));
    await expect(fetchTicketsBatch("key", ["ACME-1", "ACME-2", "ACME-3"], run)).rejects.toThrow("Linear API 429");
    // Rejected on the first failure — never halved looking for a culprit.
    expect(calls).toHaveLength(1);
  });

  test("a transport failure after a healthy chunk still rejects, never returns partial", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `ACME-${i}`);
    let seen = 0;
    const run = async (_key: string, query: string) => {
      if (++seen > 1) throw new Error("Linear API 500");
      const chunk = [...query.matchAll(/issue\(id: "([^"]+)"\)/g)].map(m => m[1]!);
      const data: Record<string, unknown> = {};
      chunk.forEach((id, i) => { data[`i${i}`] = ticket(id); });
      return data;
    };
    await expect(fetchTicketsBatch("key", ids, run)).rejects.toThrow("Linear API 500");
  });
});
