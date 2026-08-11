// RT-25: the dev-mode wrapper must not use bun's --tsconfig-override.
// That flag trips a bun fd-bookkeeping bug (oven-sh/bun#22023) that makes
// every dev-mode rt command trail an "Internal error: directory mismatch"
// line on exit. Instead the wrapper cds into the rt source repo (so bun
// resolves rt's own tsconfig from cwd) and a preload script restores the
// user's launch cwd before any other module loads.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_MODE_PRELOAD, renderDevModePreload, renderDevModeWrapper } from "../../commands/settings.ts";

const SOURCE = "/Users/someone/checkouts/repo-tools";
const BUN = "/Users/someone/.bun/bin/bun";

describe("renderDevModeWrapper", () => {
  const wrapper = renderDevModeWrapper(SOURCE, BUN);

  test("does not use --tsconfig-override (bun#22023 regression guard)", () => {
    expect(wrapper).not.toContain("--tsconfig-override");
  });

  test("captures the launch cwd, then cds into the source repo before exec", () => {
    const exportIdx = wrapper.indexOf(`export RT_LAUNCH_CWD="$PWD"`);
    const cdIdx = wrapper.indexOf(`cd "${SOURCE}"`);
    const execIdx = wrapper.indexOf(`exec "${BUN}"`);
    expect(exportIdx).toBeGreaterThan(-1);
    expect(cdIdx).toBeGreaterThan(exportIdx);
    expect(execIdx).toBeGreaterThan(cdIdx);
  });

  test("preloads the cwd-restore script and runs cli.ts with forwarded args", () => {
    expect(wrapper).toContain(`--preload="${DEV_MODE_PRELOAD}"`);
    expect(wrapper).toContain(`"${SOURCE}/cli.ts" "$@"`);
  });

  test("fails loudly when the source checkout is gone instead of exec'ing from the wrong cwd", () => {
    expect(wrapper).toMatch(/cd "[^"]+" \|\| \{/);
  });
});

describe("renderDevModePreload", () => {
  test("restores RT_LAUNCH_CWD before other modules load, then scrubs it", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt25-")));
    const launchDir = realpathSync(mkdtempSync(join(tmpdir(), "rt25-launch-")));
    const preloadPath = join(dir, "dev-restore-cwd.ts");
    const entryPath = join(dir, "print.ts");
    writeFileSync(preloadPath, renderDevModePreload());
    writeFileSync(
      entryPath,
      `console.log(JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD, launch: process.env.RT_LAUNCH_CWD ?? null }));\n`,
    );

    const proc = Bun.spawn([process.execPath, "run", `--preload=${preloadPath}`, entryPath], {
      cwd: dir,
      env: { ...process.env, RT_LAUNCH_CWD: launchDir, PWD: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited).toBe(0);
    expect(stderr).not.toContain("Internal error");

    const seen = JSON.parse(stdout.trim());
    expect(seen.cwd).toBe(launchDir);
    expect(seen.pwd).toBe(launchDir);
    expect(seen.launch).toBeNull();
  });

  test("survives a launch cwd that no longer exists", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt25-")));
    const preloadPath = join(dir, "dev-restore-cwd.ts");
    const entryPath = join(dir, "print.ts");
    writeFileSync(preloadPath, renderDevModePreload());
    writeFileSync(entryPath, `console.log(process.cwd());\n`);

    const proc = Bun.spawn([process.execPath, "run", `--preload=${preloadPath}`, entryPath], {
      cwd: dir,
      env: { ...process.env, RT_LAUNCH_CWD: join(dir, "deleted-subdir-that-never-existed") },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
  });
});
