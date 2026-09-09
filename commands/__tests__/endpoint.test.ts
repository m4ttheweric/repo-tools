import { describe, expect, test } from "bun:test";
import { buildLookupOutput, parseEndpointLookupArgs, parseEndpointReleaseArgs } from "../endpoint.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[\d+m/g, "");

describe("parseEndpointReleaseArgs", () => {
  test("worktree first, no role", () => {
    expect(parseEndpointReleaseArgs(["/path/wt"])).toEqual({ worktree: "/path/wt", role: undefined, roleInvalid: false });
  });

  test("--json before the worktree, no role", () => {
    expect(parseEndpointReleaseArgs(["--json", "/path/wt"])).toEqual({ worktree: "/path/wt", role: undefined, roleInvalid: false });
  });

  test("worktree then --role", () => {
    expect(parseEndpointReleaseArgs(["/path/wt", "--role", "web"])).toEqual({ worktree: "/path/wt", role: "web", roleInvalid: false });
  });

  test("--role before the worktree", () => {
    expect(parseEndpointReleaseArgs(["--role", "web", "/path/wt"])).toEqual({ worktree: "/path/wt", role: "web", roleInvalid: false });
  });

  test("--role with no following value is flagged invalid, not treated as omitted", () => {
    expect(parseEndpointReleaseArgs(["/path/wt", "--role"])).toEqual({
      worktree: "/path/wt",
      role: undefined,
      roleInvalid: true,
    });
  });

  test("--role followed by --json (option-like) is flagged invalid, not treated as a role value", () => {
    expect(parseEndpointReleaseArgs(["/path/wt", "--role", "--json"])).toEqual({
      worktree: "/path/wt",
      role: undefined,
      roleInvalid: true,
    });
  });
});

describe("parseEndpointLookupArgs", () => {
  test("role only", () => {
    expect(parseEndpointLookupArgs(["backend"])).toEqual({ role: "backend", path: undefined, pathInvalid: false });
  });

  test("--json is not a role", () => {
    expect(parseEndpointLookupArgs(["--json", "backend"])).toEqual({ role: "backend", path: undefined, pathInvalid: false });
  });

  test("--path before the role", () => {
    expect(parseEndpointLookupArgs(["--path", "/wt/seamus", "backend"])).toEqual({
      role: "backend",
      path: "/wt/seamus",
      pathInvalid: false,
    });
  });

  test("--path after the role", () => {
    expect(parseEndpointLookupArgs(["backend", "--path", "/wt/seamus"])).toEqual({
      role: "backend",
      path: "/wt/seamus",
      pathInvalid: false,
    });
  });

  test("--path with no following value is flagged invalid, not treated as omitted", () => {
    expect(parseEndpointLookupArgs(["backend", "--path"])).toEqual({ role: "backend", path: undefined, pathInvalid: true });
  });

  test("--path followed by --json (option-like) is flagged invalid, not treated as a path value", () => {
    expect(parseEndpointLookupArgs(["backend", "--path", "--json"])).toEqual({
      role: "backend",
      path: undefined,
      pathInvalid: true,
    });
  });
});

describe("buildLookupOutput", () => {
  const ctx = { role: "portal", repoName: "repo-tools", toplevel: "/wt/seamus", indexPath: "/repo/main" };
  const base = { claimed: true, port: 4001, url: "http://localhost:4001", running: true };

  test("running and owned: json carries worktree with main:false, plain names the worktree, no warnings", () => {
    const data = {
      ...base,
      worktree: { path: "/wt/seamus", name: "seamus" },
      listener: { pid: 55, command: "node", cwd: "/wt/seamus/apps/web", ownsClaim: true },
    };
    const { payload, lines } = buildLookupOutput(data, ctx);
    expect(payload).toMatchObject({ ok: true, claimed: true, port: 4001, worktree: { path: "/wt/seamus", name: "seamus", main: false } });
    const plain = stripAnsi(lines.join("\n"));
    expect(plain).toContain("http://localhost:4001");
    expect(plain).toContain("(running)");
    expect(plain).toContain("worktree seamus (/wt/seamus)");
    expect(plain).not.toContain("does not belong");
    expect(plain).not.toContain("canonical main checkout");
  });

  test("a foreign listener is called out, loudly", () => {
    const data = {
      ...base,
      worktree: { path: "/wt/seamus", name: "seamus" },
      listener: { pid: 99, command: "node", cwd: "/wt/dobby", ownsClaim: false },
    };
    const { payload, lines } = buildLookupOutput(data, ctx);
    expect(payload).toMatchObject({ listener: { pid: 99, ownsClaim: false } });
    const plain = stripAnsi(lines.join("\n"));
    expect(plain).toContain("does not belong to this worktree");
    expect(plain).toContain("pid 99");
    expect(plain).toContain("/wt/dobby");
  });

  test("an unattributable listener is flagged as unverified, not as foreign", () => {
    const data = {
      ...base,
      worktree: { path: "/wt/seamus", name: "seamus" },
      listener: { pid: 99, command: "node", cwd: null, ownsClaim: null },
    };
    const plain = stripAnsi(buildLookupOutput(data, ctx).lines.join("\n"));
    expect(plain).toContain("could not be attributed");
    expect(plain).not.toContain("does not belong");
  });

  test("running via pid with nothing listening reads as not listening yet", () => {
    const data = { ...base, worktree: { path: "/wt/seamus", name: null }, listener: null };
    const plain = stripAnsi(buildLookupOutput(data, ctx).lines.join("\n"));
    expect(plain).toContain("not listening yet");
    expect(plain).toContain("worktree /wt/seamus");
  });

  test("invoked from the canonical main checkout: json main:true and a plain warning", () => {
    const mainCtx = { ...ctx, toplevel: "/repo/main" };
    const data = { ...base, worktree: { path: "/repo/main", name: null }, listener: null };
    const { payload, lines } = buildLookupOutput(data, mainCtx);
    expect(payload).toMatchObject({ worktree: { path: "/repo/main", name: null, main: true } });
    expect(stripAnsi(lines.join("\n"))).toContain("canonical main checkout");
  });

  test("an old daemon response without worktree/listener still renders, worktree from the CLI's own resolution", () => {
    const { payload, lines } = buildLookupOutput({ ...base, running: false }, ctx);
    expect(payload).toMatchObject({ worktree: { path: "/wt/seamus", name: null, main: false }, listener: null });
    const plain = stripAnsi(lines.join("\n"));
    expect(plain).toContain("(claimed, not running)");
    expect(plain).toContain("worktree /wt/seamus");
  });

  test("no claim: plain says so and still reports worktree context", () => {
    const data = { claimed: false, port: null, url: null, running: false, worktree: { path: "/wt/seamus", name: "seamus" }, listener: null };
    const { payload, lines } = buildLookupOutput(data, ctx);
    expect(payload).toMatchObject({ claimed: false, worktree: { path: "/wt/seamus", name: "seamus", main: false } });
    const plain = stripAnsi(lines.join("\n"));
    expect(plain).toContain('no claim for role "portal"');
    expect(plain).toContain("worktree seamus");
  });
});
