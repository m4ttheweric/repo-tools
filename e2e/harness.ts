import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export const RT_BINARY = process.env.RT_BINARY || join(import.meta.dir, "..", "dist", "rt");

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RunOpts {
  home?: string;
  env?: Record<string, string>;
}

export function createTestHome(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "rt-e2e-"));

  writeFileSync(
    join(path, ".gitconfig"),
    "[user]\n\tname = rt-test\n\temail = test@rt.test\n",
  );

  writeFileSync(join(path, ".zshrc"), "");

  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

async function run(
  args: string[],
  opts: RunOpts & { skipSetup: boolean },
): Promise<RunResult> {
  const home = opts.home ?? createTestHome().path;

  // Connector scaffolds (rt sdm connectors init) run via `#!/usr/bin/env bun`,
  // so bun's own directory must be on PATH for the spawned rt binary's
  // children to find it. process.execPath is the running bun binary itself,
  // which resolves correctly whether bun was installed via the bun installer
  // (~/.bun/bin) or Homebrew (/opt/homebrew/bin) -- unlike a hardcoded guess.
  const bunDir = join(process.execPath, "..");

  const env: Record<string, string> = {
    HOME: home,
    PATH: `${join(RT_BINARY, "..")}:${bunDir}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`,
    TERM: "xterm-256color",
    ...opts.env,
  };

  if (opts.skipSetup) {
    env.RT_SKIP_SETUP = "1";
    env.CI = "true";
  }

  const proc = Bun.spawn([RT_BINARY, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    cwd: home,
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

export function rt(args: string[], opts?: RunOpts): Promise<RunResult> {
  return run(args, { ...opts, skipSetup: true });
}

export function rtRaw(args: string[], opts?: RunOpts): Promise<RunResult> {
  return run(args, { ...opts, skipSetup: false });
}
