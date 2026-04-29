/**
 * rt mr open / rt pr open         — create a GitLab MR on the current branch (thin glab wrapper).
 * rt mr describe / rt pr describe — draft a description with an agent (streams to stdout).
 * rt mr ship / rt pr ship         — composite: push + describe + open. The all-in-one.
 *
 * Config lives at ~/.rt/<repo>/mr.json. All three commands share the same
 * helpers (`generateDescription`, `runGlabCreate`) so behavior is consistent
 * whether a user chains atoms by hand or runs the composite.
 */

import { execSync, spawnSync } from "child_process";
import { readFileSync } from "fs";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import { getCurrentBranch, getRemoteDefaultBranch } from "../lib/git-ops.ts";
import {
  loadMRConfig,
  readPromptFile,
  resolveConfigPath,
  type MRConfig,
} from "../lib/mr-config.ts";
import { resolveAgentInvocation, runAgent } from "../lib/agent-runner.ts";
import { pushCommand } from "./git/push.ts";
import type { CommandContext } from "../lib/command-tree.ts";

// ─── Arg helpers ─────────────────────────────────────────────────────────────

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

// ─── Platform / git helpers ──────────────────────────────────────────────────

function isGitLab(remoteUrl: string | undefined): boolean {
  return !!remoteUrl && /gitlab\./i.test(remoteUrl);
}

function isGitHub(remoteUrl: string | undefined): boolean {
  return !!remoteUrl && /github\.com/i.test(remoteUrl);
}

function remoteBranchExists(branch: string, cwd: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--verify", `origin/${branch}`], {
    cwd, stdio: "pipe",
  });
  return r.status === 0;
}

function commitsAhead(targetRef: string, cwd: string): number {
  const r = spawnSync("git", ["rev-list", "--count", `${targetRef}...HEAD`], {
    cwd, stdio: "pipe", encoding: "utf8",
  });
  if (r.status !== 0) return 0;
  return parseInt((r.stdout ?? "").trim(), 10) || 0;
}

function lastCommitSubject(cwd: string): string {
  try {
    return execSync("git log -1 --pretty=%s", { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function readDescriptionFile(path: string): string {
  if (path === "-") return readFileSync(0, "utf8");
  return readFileSync(path, "utf8");
}

function extractMRUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]*\/-\/merge_requests\/\d+/);
  return match ? match[0] : null;
}

function resolveTarget(args: string[], config: MRConfig, cwd: string): string {
  return argValue(args, "--target")
    ?? config.target
    ?? getRemoteDefaultBranch(cwd)?.replace(/^origin\//, "")
    ?? "master";
}

function platformGate(remoteUrl: string | undefined): void {
  if (isGitHub(remoteUrl)) {
    console.error(`\n  ${yellow}GitHub not supported yet — use ${bold}gh pr create${reset}${yellow} for now${reset}\n`);
    process.exit(1);
  }
  if (!isGitLab(remoteUrl)) {
    console.error(`\n  ${red}remote does not look like GitLab: ${dim}${remoteUrl}${reset}\n`);
    process.exit(1);
  }
}

// ─── generateDescription — shared by describe and create ─────────────────────

function gitCapture(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  return r.status === 0 ? (r.stdout ?? "") : "";
}

function truncate(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const head = buf.subarray(0, maxBytes).toString("utf8");
  const skipped = buf.length - maxBytes;
  return `${head}\n\n[... ${Math.round(skipped / 1024)}KB of diff truncated ...]`;
}

interface LoadedPrompt { source: string; body: string; }

function loadPrompts(config: MRConfig, dataDir: string): {
  loaded: LoadedPrompt[]; missing: string[];
} {
  const loaded: LoadedPrompt[] = [];
  const missing: string[] = [];
  for (const raw of config.prompts ?? []) {
    const path = resolveConfigPath(raw, dataDir);
    const body = readPromptFile(path);
    if (body === null) missing.push(raw);
    else loaded.push({ source: raw, body: body.trim() });
  }
  return { loaded, missing };
}

function collectContextFiles(config: MRConfig, cwd: string): LoadedPrompt[] {
  const include = config.context?.include ?? [];
  const exclude = config.context?.exclude ?? [];
  if (include.length === 0) return [];

  let files: string[] = [];
  try {
    const out = execSync(
      `git ls-files -- ${include.map((g) => `'${g}'`).join(" ")}`,
      { cwd, encoding: "utf8" },
    );
    files = out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    files = [];
  }

  if (exclude.length > 0) {
    files = files.filter((f) => !exclude.some((g) => {
      try { return new Bun.Glob(g).match(f); } catch { return false; }
    }));
  }

  const out: LoadedPrompt[] = [];
  for (const f of files) {
    try {
      const body = readFileSync(`${cwd}/${f}`, "utf8");
      out.push({ source: f, body: body.trim() });
    } catch { /* skip */ }
  }
  return out;
}

function captureGitSnapshot(
  branch: string, target: string, cwd: string, maxDiffBytes: number,
) {
  const ref = `origin/${target}...HEAD`;
  return {
    branch, target,
    commits: gitCapture(["log", ref, "--pretty=format:- %h %s", "-n", "20"], cwd).trim(),
    changedFiles: gitCapture(["diff", "--name-only", ref], cwd).trim(),
    diffStat: gitCapture(["diff", "--stat", ref], cwd).trim(),
    diff: truncate(gitCapture(["diff", ref], cwd), maxDiffBytes),
  };
}

/**
 * Pull a `Title: ...` line off the top of agent output and return the title
 * plus the body with that line (and any leading blank line) removed.
 * Returns `{ title: undefined, body: raw }` when no title line is present.
 */
function splitTitleAndBody(raw: string): { title?: string; body: string } {
  const match = raw.match(/^[ \t]*Title:[ \t]*(.+?)[ \t]*\r?\n\r?\n?/);
  if (!match || !match[1]) return { body: raw };
  const title = match[1].trim();
  if (!title) return { body: raw };
  return { title, body: raw.slice(match[0].length) };
}

function assemblePrompt(
  prompts: LoadedPrompt[],
  contextFiles: LoadedPrompt[],
  inline: string | undefined,
  git: ReturnType<typeof captureGitSnapshot>,
): string {
  const parts: string[] = [];

  if (prompts.length > 0) {
    parts.push("# Style and template guidance\n");
    for (const p of prompts) parts.push(`<!-- from: ${p.source} -->\n${p.body}`);
  }

  if (contextFiles.length > 0) {
    parts.push("# Additional context files\n");
    for (const c of contextFiles) parts.push(`<!-- ${c.source} -->\n\`\`\`\n${c.body}\n\`\`\``);
  }

  if (inline && inline.trim().length > 0) {
    parts.push(`# Additional inline guidance\n\n${inline.trim()}`);
  }

  parts.push(
    `# Git state\n`
    + `\nBranch: ${git.branch}\n`
    + `Target: ${git.target}\n`
    + `\n## Commits (HEAD vs origin/${git.target})\n\n${git.commits || "(none)"}\n`
    + `\n## Changed files\n\n${git.changedFiles || "(none)"}\n`
    + `\n## Diff stat\n\n\`\`\`\n${git.diffStat || "(none)"}\n\`\`\`\n`
    + `\n## Diff\n\n\`\`\`diff\n${git.diff || "(none)"}\n\`\`\``,
  );

  parts.push(
    `# Task\n\n`
    + `Write a merge-request title and description for this branch, following `
    + `the style and template guidance above.\n\n`
    + `Output format (strict):\n`
    + `1. The FIRST line must be exactly: \`Title: <merge request title>\`\n`
    + `2. Then a single blank line.\n`
    + `3. Then ONLY the markdown body of the description — no preamble, no `
    + `explanation, no surrounding code fence.`,
  );

  return parts.join("\n\n");
}

interface GenerateOpts {
  cwd: string;
  dataDir: string;
  branch: string;
  target: string;
  config: MRConfig;
  extraInline?: string;
  /** If true, don't call the agent — return the assembled prompt as `description`. */
  debug?: boolean;
  /** Header label for the stderr banner (e.g. "rt mr describe" or "rt mr ship"). */
  label: string;
}

/**
 * Run the describe flow: gather context, assemble prompt, stream agent to stdout.
 * Returns the captured description. Writes progress + errors to stderr.
 * Calls process.exit(1) on fatal errors.
 */
async function generateDescription(opts: GenerateOpts): Promise<string> {
  const { cwd, dataDir, branch, target, config, extraInline, debug, label } = opts;

  const note = (msg: string) => process.stderr.write(`  ${dim}${msg}${reset}\n`);
  process.stderr.write(`\n  ${bold}${cyan}${label}${reset} ${dim}(${branch} vs ${target})${reset}\n`);

  const { loaded: prompts, missing } = loadPrompts(config, dataDir);
  for (const m of missing) {
    process.stderr.write(`  ${yellow}! prompt not found:${reset} ${m}\n`);
  }
  note(`prompts:  ${prompts.length}${prompts.length > 0 ? ` (${prompts.map((p) => p.source).join(", ")})` : ""}`);

  const contextFiles = collectContextFiles(config, cwd);
  note(`context:  ${contextFiles.length}${contextFiles.length > 0 ? ` file${contextFiles.length === 1 ? "" : "s"}` : ""}`);

  const maxDiffKb = config.agent?.maxDiffKb ?? 80;
  const git = captureGitSnapshot(branch, target, cwd, maxDiffKb * 1024);
  const commitCount = git.commits ? git.commits.split("\n").length : 0;
  const fileCount = git.changedFiles ? git.changedFiles.split("\n").length : 0;
  note(`git:      ${commitCount} commit${commitCount === 1 ? "" : "s"}, ${fileCount} file${fileCount === 1 ? "" : "s"} changed`);

  const inline = [config.inline, extraInline].filter(Boolean).join("\n\n");
  const fullPrompt = assemblePrompt(prompts, contextFiles, inline, git);
  note(`prompt:   ${Math.round(Buffer.byteLength(fullPrompt, "utf8") / 1024)}KB`);

  if (debug) {
    process.stderr.write(`  ${yellow}--debug — printing assembled prompt instead of calling agent${reset}\n\n`);
    return fullPrompt;
  }

  const { cli, args: cliArgs } = resolveAgentInvocation({
    cli: config.agent?.cli,
    args: config.agent?.args,
  });
  process.stderr.write(`  ${dim}agent:    ${cli} ${cliArgs.join(" ")}${reset}\n\n`);

  const result = await runAgent({
    cli, args: cliArgs, prompt: fullPrompt, cwd, stream: process.stdout,
  });

  if (!result.ok) {
    process.stderr.write(`\n  ${red}agent exited ${result.exitCode ?? "?"}${reset}\n`);
    if (result.stderr.trim()) process.stderr.write(`${result.stderr.trim()}\n`);
    process.exit(1);
  }

  if (!result.stdout.endsWith("\n")) process.stdout.write("\n");
  process.stderr.write(`\n  ${green}✓${reset} ${dim}description drafted${reset}\n`);
  return result.stdout;
}

// ─── runGlabCreate — shared by open and create ────────────────────────────────

interface GlabCreateOpts {
  cwd: string;
  branch: string;
  target: string;
  title: string;
  draft: boolean;
  config: MRConfig;
  /** Description body. If undefined + useFill=false, creates MR with no body. */
  description?: string;
  useFill?: boolean;
  dryRun?: boolean;
  label: string;
}

/**
 * Run `glab mr create` and return the parsed URL. Streams glab output via a
 * step spinner. Calls process.exit(1) on glab failure.
 */
async function runGlabCreate(opts: GlabCreateOpts): Promise<string | null> {
  const {
    cwd, branch, target, title, draft, config, description, useFill, dryRun, label,
  } = opts;

  let descriptionArgs: string[] = [];
  if (description !== undefined) {
    descriptionArgs = ["--description", description];
  } else if (useFill) {
    descriptionArgs = ["--fill"];
  }

  const glabArgs: string[] = [
    "mr", "create",
    "--no-editor", "--yes",
    "--title", title,
    "--target-branch", target,
    "--source-branch", branch,
    ...descriptionArgs,
  ];
  if (draft) glabArgs.push("--draft");
  if (config.removeSourceBranch) glabArgs.push("--remove-source-branch");
  if (config.squash) glabArgs.push("--squash-before-merge");

  console.log(`\n  ${bold}${cyan}${label}${reset} ${dim}(${branch} → ${target})${reset}`);
  console.log(`  ${dim}title:${reset}  ${title}`);
  console.log(`  ${dim}target:${reset} ${target}${draft ? `  ${dim}(draft)${reset}` : ""}`);
  // Redact long description bodies in the preview.
  const previewArgs = glabArgs.map((a, i) => {
    if (i > 0 && glabArgs[i - 1] === "--description" && a.length > 80) {
      return `<${Math.round(Buffer.byteLength(a, "utf8") / 1024)}KB>`;
    }
    return a.includes(" ") ? `"${a}"` : a;
  });
  console.log(`  ${dim}glab ${previewArgs.join(" ")}${reset}\n`);

  if (dryRun) {
    console.log(`  ${yellow}--dry-run — not running${reset}\n`);
    return null;
  }

  const { createStepRunner } = await import("../lib/rt-render.tsx");
  const steps = createStepRunner();

  let stdout = "";
  let stderr = "";
  try {
    await steps.run("creating MR…", async () => {
      const r = spawnSync("glab", glabArgs, { cwd, encoding: "utf8", stdio: "pipe" });
      stdout = r.stdout ?? "";
      stderr = r.stderr ?? "";
      if (r.status !== 0) {
        const msg = (stderr || stdout).trim().split("\n").pop() || `glab exited ${r.status}`;
        throw new Error(msg);
      }
    }, { done: "MR created" });
  } catch {
    if (stderr.trim()) console.error(`\n${stderr.trim()}\n`);
    process.exit(1);
  }

  return extractMRUrl(stdout) ?? extractMRUrl(stderr);
}

// ─── rt mr open ──────────────────────────────────────────────────────────────

export async function openCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const cwd = ctx.identity!.repoRoot;
  const dataDir = ctx.identity!.dataDir;

  platformGate(ctx.identity!.remoteUrl);

  const branch = getCurrentBranch(cwd);
  if (!branch) {
    console.error(`\n  ${red}not on a branch (detached HEAD)${reset}\n`);
    process.exit(1);
  }

  const config = loadMRConfig(dataDir);
  const target = resolveTarget(args, config, cwd);

  if (branch === target) {
    console.error(`\n  ${red}on target branch ${bold}${target}${reset}${red} — nothing to MR${reset}\n`);
    process.exit(1);
  }

  if (!remoteBranchExists(branch, cwd)) {
    console.error(`\n  ${yellow}${bold}${branch}${reset}${yellow} has not been pushed yet${reset}`);
    console.error(`  ${dim}run${reset} ${bold}rt git push${reset} ${dim}first${reset}\n`);
    process.exit(1);
  }

  if (commitsAhead(`origin/${target}`, cwd) === 0) {
    console.error(`\n  ${red}no commits between ${bold}origin/${target}${reset}${red} and ${bold}${branch}${reset}\n`);
    process.exit(1);
  }

  const title = argValue(args, "--title") ?? lastCommitSubject(cwd) ?? branch;
  const draft = args.includes("--no-draft") ? false
    : (args.includes("--draft") || (config.draft ?? false));

  const descFileArg = argValue(args, "--description-file");
  const descInline = argValue(args, "--description");
  const useFill = args.includes("--fill");

  let description: string | undefined;
  if (descFileArg) description = readDescriptionFile(descFileArg);
  else if (descInline !== undefined) description = descInline;

  const url = await runGlabCreate({
    cwd, branch, target, title, draft, config,
    description, useFill,
    dryRun: args.includes("--dry-run"),
    label: "rt mr open",
  });

  if (url) {
    console.log(`\n  ${green}→${reset} ${url}\n`);
    if (args.includes("--web")) {
      spawnSync("glab", ["mr", "view", "--web", url], { cwd, stdio: "ignore" });
    }
  }
}

// ─── rt mr describe ──────────────────────────────────────────────────────────

export async function describeCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const cwd = ctx.identity!.repoRoot;
  const dataDir = ctx.identity!.dataDir;

  const branch = getCurrentBranch(cwd);
  if (!branch) {
    process.stderr.write(`\n  ${red}not on a branch (detached HEAD)${reset}\n\n`);
    process.exit(1);
  }

  const config = loadMRConfig(dataDir);
  const target = resolveTarget(args, config, cwd);

  if (branch === target) {
    process.stderr.write(`\n  ${red}on target branch ${bold}${target}${reset}${red} — nothing to describe${reset}\n\n`);
    process.exit(1);
  }

  const debug = args.includes("--debug");
  const description = await generateDescription({
    cwd, dataDir, branch, target, config,
    extraInline: argValue(args, "--inline"),
    debug,
    label: "rt mr describe",
  });

  // In --debug we returned the prompt; print it to stdout so piping still works.
  if (debug) {
    process.stdout.write(description);
    if (!description.endsWith("\n")) process.stdout.write("\n");
  }
  process.stderr.write("\n");
}

// ─── rt mr ship (composite) ──────────────────────────────────────────────────

export async function shipCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const cwd = ctx.identity!.repoRoot;
  const dataDir = ctx.identity!.dataDir;

  platformGate(ctx.identity!.remoteUrl);

  const branch = getCurrentBranch(cwd);
  if (!branch) {
    console.error(`\n  ${red}not on a branch (detached HEAD)${reset}\n`);
    process.exit(1);
  }

  const config = loadMRConfig(dataDir);
  const target = resolveTarget(args, config, cwd);

  if (branch === target) {
    console.error(`\n  ${red}on target branch ${bold}${target}${reset}${red} — nothing to MR${reset}\n`);
    process.exit(1);
  }

  // Step 1: push. pushCommand exits the process on failure, so if we reach
  // the next line the push succeeded (or was up-to-date). --dry-run flows
  // through to pushCommand too — the whole composite becomes a rehearsal.
  await pushCommand(args, ctx);

  if (commitsAhead(`origin/${target}`, cwd) === 0) {
    console.error(`\n  ${red}no commits between ${bold}origin/${target}${reset}${red} and ${bold}${branch}${reset}\n`);
    process.exit(1);
  }

  // Step 2: generate description (streams to stdout; we capture the text).
  const debug = args.includes("--debug");
  const description = await generateDescription({
    cwd, dataDir, branch, target, config,
    extraInline: argValue(args, "--inline"),
    debug,
    label: "rt mr describe",
  });

  if (debug) {
    process.stdout.write(description);
    if (!description.endsWith("\n")) process.stdout.write("\n");
    process.stderr.write(`\n  ${yellow}--debug — stopping before MR creation${reset}\n\n`);
    return;
  }

  // Step 3: create MR with the drafted description.
  // Prefer agent-emitted `Title: ...` line over the last commit subject so
  // the style/template guidance can shape the title, not just the body.
  const { title: agentTitle, body } = splitTitleAndBody(description);
  const title = argValue(args, "--title") ?? agentTitle ?? lastCommitSubject(cwd) ?? branch;
  const draft = args.includes("--no-draft") ? false
    : (args.includes("--draft") || (config.draft ?? false));

  const url = await runGlabCreate({
    cwd, branch, target, title, draft, config,
    description: body.trimEnd(),
    dryRun: args.includes("--dry-run"),
    label: "rt mr open",
  });

  if (url) {
    console.log(`\n  ${green}→${reset} ${url}\n`);
    if (args.includes("--web")) {
      spawnSync("glab", ["mr", "view", "--web", url], { cwd, stdio: "ignore" });
    }
  }
}
