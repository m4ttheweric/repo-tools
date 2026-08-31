import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dir, "..", "deps-lock.ts");

function altLock(): string {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  const path = join(dir, "alt.lock");
  writeFileSync(path, JSON.stringify({
    schema: 1, arch: "arm64",
    tools: [{
      name: "toolx", version: "9.9.9", license: "MIT",
      url: "https://example.com/toolx.tgz", sha256: "b".repeat(64),
      archive: "tar.gz", extract: "toolx",
      bundlePath: "Contents/Helpers/toolx", exec: ["Contents/Helpers/toolx"],
      exposeByDefault: false, entitlements: "none", status: "bundled", kind: "helper",
    }],
  }));
  return path;
}

test("--lock <path> reads the alternate lock", async () => {
  const proc = Bun.spawn(["bun", CLI, "--lock", altLock()], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out).toContain("toolx\t9.9.9\t");
  expect(out).not.toContain("fzf");
});

test("default path still reads the repo lock", async () => {
  const proc = Bun.spawn(["bun", CLI, "--arch"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out.trim()).toBe("arm64");
});
