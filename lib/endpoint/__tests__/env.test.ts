import { describe, expect, test } from "bun:test";
import { applyArgInject, collectPreservedKeys, renderEnvTemplates, runRoleHook } from "../env.ts";

const alloc = { role: "portal", port: 5001, refs: { backend: { port: 10400, url: "http://localhost:10400", running: true } } };

describe("renderEnvTemplates", () => {
  test("renders ${port} and ${roles.X.port}; unknown refs render empty and warn-free", () => {
    expect(renderEnvTemplates({ PORT: "${port}", EP: "http://localhost:${roles.backend.port}", BAD: "${roles.nope.port}" }, alloc))
      .toEqual({ PORT: "5001", EP: "http://localhost:10400", BAD: "" });
  });
});

describe("collectPreservedKeys", () => {
  test("keeps exact names and expands trailing-star prefixes, present-only", () => {
    const caller = { POSTGRES_URL: "x", FEATURE_FLAG_A: "1", FEATURE_FLAG_B: "", OTHER: "y" };
    expect(collectPreservedKeys(["POSTGRES_URL", "FEATURE_FLAG_*", "MISSING"], caller))
      .toEqual(["POSTGRES_URL", "FEATURE_FLAG_A", "FEATURE_FLAG_B"]);
  });
});

describe("applyArgInject", () => {
  test("inserts after the anchor arg unless the skip marker is present", () => {
    expect(applyArgInject(["run", "--", "pnpm", "start"], { afterArg: "run", template: "--preserve-env=${envKeys}", skipIfArgPresent: "--preserve-env" }, ["PORT", "POSTGRES_URL"]))
      .toEqual(["run", "--preserve-env=PORT,POSTGRES_URL", "--", "pnpm", "start"]);
    expect(applyArgInject(["run", "--preserve-env=X", "cmd"], { afterArg: "run", template: "--preserve-env=${envKeys}", skipIfArgPresent: "--preserve-env" }, ["PORT"]))
      .toEqual(["run", "--preserve-env=X", "cmd"]);
  });
});

describe("runRoleHook", () => {
  test("round-trips JSON and fails open on a broken hook", async () => {
    const echo = await runRoleHook(`bun -e 'const i=await new Response(Bun.stdin.stream()).json(); console.log(JSON.stringify({env:{HOOKED: String(i.port)}}))'`,
      { worktree: "/wt/a", role: "portal", port: 5001, refs: {}, env: {} });
    expect(echo).toEqual({ env: { HOOKED: "5001" } });
    expect(await runRoleHook("false", { worktree: "/w", role: "r", port: 1, refs: {}, env: {} })).toBeNull();
    expect(await runRoleHook("sleep 30", { worktree: "/w", role: "r", port: 1, refs: {}, env: {} }, 200)).toBeNull();
  });

  test("honors its deadline when a backgrounded grandchild holds the pipes open", async () => {
    // sh exits immediately, but `sleep 30 &` inherits stdout/stderr — reading
    // to EOF would block for 30s. The contract is the time bound, not which of
    // (parsed env | null) comes back.
    const started = Date.now();
    const res = await runRoleHook("sleep 30 & echo '{}'", { worktree: "/w", role: "r", port: 1, refs: {}, env: {} }, 500);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(3000);
    expect(res === null || (typeof res === "object" && res.env === undefined)).toBe(true);
  });
});
