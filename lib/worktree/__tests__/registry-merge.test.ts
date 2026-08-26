import { describe, expect, test } from "bun:test";
import { mergeRegistries, type TreeRecord } from "../registry.ts";

function rec(over: Partial<TreeRecord> & { path: string }): TreeRecord {
  return {
    name: over.path.split("/").pop()!,
    kind: "unmanaged",
    branch: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("mergeRegistries", () => {
  test("unions disjoint paths, winner side first", () => {
    const merged = mergeRegistries([rec({ path: "/a/main" })], [rec({ path: "/a/tree-1" })]);
    expect(merged.map((t) => t.path)).toEqual(["/a/main", "/a/tree-1"]);
  });

  test("an empty loser returns the winner unchanged", () => {
    const winner = [rec({ path: "/a/main" }), rec({ path: "/a/tree-1" })];
    expect(mergeRegistries(winner, [])).toEqual(winner);
  });

  test("an empty winner returns the loser's records", () => {
    const loser = [rec({ path: "/a/main", kind: "main" })];
    expect(mergeRegistries([], loser)).toEqual(loser);
  });

  test("on a shared path the managed record wins, whichever side it is on", () => {
    const claimed = rec({ path: "/a/tree-1", kind: "ephemeral", state: "claimed", owner: "matt" });
    const adopted = rec({ path: "/a/tree-1", kind: "unmanaged" });

    expect(mergeRegistries([adopted], [claimed])[0]).toEqual(claimed);
    expect(mergeRegistries([claimed], [adopted])[0]).toEqual(claimed);
  });

  test("two managed records on one path: the later createdAt wins", () => {
    const older = rec({ path: "/a/tree-1", kind: "ephemeral", state: "on-deck", createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = rec({ path: "/a/tree-1", kind: "ephemeral", state: "claimed", createdAt: "2026-02-01T00:00:00.000Z" });

    expect(mergeRegistries([older], [newer])[0]).toEqual(newer);
    expect(mergeRegistries([newer], [older])[0]).toEqual(newer);
  });

  test("an equal createdAt keeps the winner side", () => {
    const w = rec({ path: "/a/tree-1", kind: "ephemeral", state: "on-deck", owner: "winner" });
    const l = rec({ path: "/a/tree-1", kind: "ephemeral", state: "on-deck", owner: "loser" });
    expect(mergeRegistries([w], [l])[0]!.owner).toBe("winner");
  });

  test("an unparseable createdAt never displaces the winner", () => {
    const w = rec({ path: "/a/tree-1", kind: "ephemeral", createdAt: "2026-01-01T00:00:00.000Z", owner: "winner" });
    const l = rec({ path: "/a/tree-1", kind: "ephemeral", createdAt: "not a date", owner: "loser" });
    expect(mergeRegistries([w], [l])[0]!.owner).toBe("winner");
  });

  test("a duplicate path inside one side keeps its first occurrence", () => {
    const first = rec({ path: "/a/tree-1", kind: "ephemeral", owner: "first" });
    const second = rec({ path: "/a/tree-1", kind: "ephemeral", owner: "second" });
    expect(mergeRegistries([first, second], [])).toEqual([first]);
  });
});
