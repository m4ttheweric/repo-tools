import { describe, test, expect } from "bun:test";
import { flattenCommands } from "./commands.ts";
import type { WorktreePackage } from "./types.ts";

const pkgs: WorktreePackage[] = [
  { name: "root", dir: "/w", scripts: [{ name: "build", cmd: "tsc" }] },
  { name: "@x/api", dir: "/w/apps/api", scripts: [{ name: "dev", cmd: "vite" }, { name: "test", cmd: "bun test" }] },
];

describe("flattenCommands", () => {
  test("flattens packages into one entry per script", () => {
    const flat = flattenCommands(pkgs);
    expect(flat).toHaveLength(3);
  });

  test("carries dir, command, and a package-qualified search text", () => {
    const dev = flattenCommands(pkgs).find((c) => c.script === "dev")!;
    expect(dev).toMatchObject({ pkg: "@x/api", dir: "/w/apps/api", cmd: "vite" });
    expect(dev.searchText).toBe("@x/api dev");
  });
});
