import { describe, expect, test } from "bun:test";
import { decideCreate, decideRemove, nameIntent } from "../claude-hook.ts";

const input = { cwd: "/fake/repo", name: "RT-123-fix-totals" };
const stockOk = async (_c: string, n: string) => ({ ok: true as const, path: `/fake/repo/.claude/worktrees/${n}` });
const stockUnused = async () => { throw new Error("stockAdd must not be called"); };

describe("nameIntent", () => {
  test("ticket-shaped name maps to ticket + title remainder", () => {
    expect(nameIntent("RT-123-fix-totals")).toEqual({ ticket: "RT-123", ticketTitle: "fix-totals" });
  });
  test("bare ticket id maps to ticket only", () => {
    expect(nameIntent("acme-1234")).toEqual({ ticket: "acme-1234" });
  });
  test("non-ticket name maps to branch verbatim", () => {
    expect(nameIntent("spike/fast-path")).toEqual({ branch: "spike/fast-path" });
  });
});

describe("decideCreate", () => {
  test("registered repo, provision ok: provisioned with the daemon's path", async () => {
    const d = await decideCreate(input, {
      repoIdentity: () => "remote:example%2Fr",
      provision: async () => ({ ok: true, data: { tree: "fred", path: "/pool/fred" } }),
      stockAdd: stockUnused,
    });
    expect(d).toEqual({ kind: "provisioned", path: "/pool/fred" });
  });
  test("daemon unreachable (null): falls back to stock tree", async () => {
    const d = await decideCreate(input, {
      repoIdentity: () => "remote:example%2Fr",
      provision: async () => null,
      stockAdd: stockOk,
    });
    expect(d.kind).toBe("fallback");
  });
  test("daemon answers repo-unknown: falls back to stock tree", async () => {
    const d = await decideCreate(input, {
      repoIdentity: () => "remote:example%2Fr",
      provision: async () => ({ ok: false, error: "repo-unknown" }),
      stockAdd: stockOk,
    });
    expect(d.kind).toBe("fallback");
  });
  test("no derivable identity: falls back without querying the daemon", async () => {
    const d = await decideCreate(input, {
      repoIdentity: () => null,
      provision: async () => { throw new Error("must not query"); },
      stockAdd: stockOk,
    });
    expect(d.kind).toBe("fallback");
  });
  test("any other daemon refusal: refused, carrying the raw error code", async () => {
    const d = await decideCreate(input, {
      repoIdentity: () => "remote:example%2Fr",
      provision: async () => ({ ok: false, error: "branch-duplicated" }),
      stockAdd: stockUnused,
    });
    expect(d).toEqual({ kind: "refused", error: "branch-duplicated" });
  });
  test("fallback path failing surfaces as refused", async () => {
    const d = await decideCreate(input, {
      repoIdentity: () => null,
      provision: async () => null,
      stockAdd: async () => ({ ok: false, error: "branch-exists:RT-123-fix-totals" }),
    });
    expect(d).toEqual({ kind: "refused", error: "branch-exists:RT-123-fix-totals" });
  });
});

describe("decideRemove", () => {
  test("rt-managed path maps to a dispose", () => {
    expect(decideRemove("/pool/fred", () => ({ repoName: "remote:example%2Fr", tree: "fred" })))
      .toEqual({ kind: "dispose", repoName: "remote:example%2Fr", tree: "fred" });
  });
  test("unknown path is a noop", () => {
    expect(decideRemove("/elsewhere/tree", () => null)).toEqual({ kind: "noop" });
  });
  test("missing path field is a noop", () => {
    expect(decideRemove(null, () => { throw new Error("must not look up"); })).toEqual({ kind: "noop" });
  });
});
