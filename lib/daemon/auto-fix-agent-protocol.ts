/**
 * Pure helpers for the auto-fix agent protocol.
 *
 *   assembleAutoFixPrompt — build the full prompt string given context.
 *   parseAgentResult     — extract the structured RESULT line from agent stdout.
 */

export interface JobLog {
  name:  string;
  trace: string;
}

export interface GitContext {
  commits:      string;
  changedFiles: string;
  diffStat:     string;
  diff:         string;
}

export interface AutoFixPromptInput {
  branch:         string;
  target:         string;
  jobLogs:        JobLog[];
  gitContext:     GitContext;
  fileCap:        number;
  lineCap:        number;
  denylist:       string[];
  allowTestFixes: boolean;
}

export function assembleAutoFixPrompt(input: AutoFixPromptInput): string {
  const parts: string[] = [];

  parts.push(
    `# Task: auto-fix a failing CI pipeline\n\n` +
    `A pipeline on this branch is failing. Make the smallest change that makes it pass. ` +
    `Stay within scope caps below. Refuse rather than guess. ` +
    `If the failure looks like a real bug (logic error, missing handling) instead of a ` +
    `mechanical issue, reply with \`RESULT: skipped\` and a one-line reason.`,
  );

  if (input.jobLogs.length > 0) {
    parts.push("## Failing job logs");
    for (const job of input.jobLogs) {
      parts.push(`### ${job.name}\n\n\`\`\`\n${job.trace}\n\`\`\``);
    }
  }

  parts.push(
    `## Git context\n\n` +
    `Branch: ${input.branch}\n` +
    `Target: ${input.target}\n\n` +
    `### Commits (HEAD vs origin/${input.target})\n\n${input.gitContext.commits || "(none)"}\n\n` +
    `### Changed files\n\n${input.gitContext.changedFiles || "(none)"}\n\n` +
    `### Diff stat\n\n\`\`\`\n${input.gitContext.diffStat || "(none)"}\n\`\`\`\n\n` +
    `### Diff\n\n\`\`\`diff\n${input.gitContext.diff || "(none)"}\n\`\`\``,
  );

  parts.push(
    `## Scope rules (hard limits)\n\n` +
    `- ≤ ${input.fileCap} files modified.\n` +
    `- ≤ ${input.lineCap} lines changed (insertions + deletions).\n` +
    `- The following paths are off-limits — do NOT modify any of them:\n` +
    input.denylist.map(p => `  - \`${p}\``).join("\n") + `\n\n` +
    (input.allowTestFixes
      ? `Test failures are in scope. Lint, type, format, and test failures may all be attempted.`
      : `Test failures are out of scope. Only attempt lint, type, and format failures. ` +
        `If the failure is a test, reply with \`RESULT: skipped: test failures opt-in only\`.`),
  );

  parts.push(
    `## Local validation before commit\n\n` +
    `Before staging your changes:\n` +
    `1. Run the project's lint and typecheck commands (consult package.json scripts, ` +
    `Makefile, or README to find them).\n` +
    `2. Confirm they pass on the changed files.\n` +
    `3. If validation fails, reply with \`RESULT: error: <one-line reason>\` and DO NOT commit.\n\n` +
    `Then \`git add\` your changes and \`git commit\` (do NOT push — the daemon pushes after ` +
    `verifying the diff).`,
  );

  parts.push(
    `## Exit protocol\n\n` +
    `End your reply with EXACTLY ONE of these lines (the daemon greps for the last \`RESULT:\` line):\n\n` +
    `  \`RESULT: fixed: <one-line summary of what you changed>\`\n` +
    `  \`RESULT: skipped: <one-line reason>\`\n` +
    `  \`RESULT: error: <one-line reason>\`\n\n` +
    `If you commit but do not include a RESULT line, the daemon will treat it as \`error\`.`,
  );

  return parts.join("\n\n");
}

export type AgentResult =
  | { kind: "fixed";        summary: string }
  | { kind: "skipped";      reason:  string }
  | { kind: "error";        note:    string }
  | { kind: "unrecognized"                  };

const RESULT_LINE_REGEX = /^\s*RESULT:\s*(fixed|skipped|error)\s*(?::\s*(.*?))?\s*$/i;

export function parseAgentResult(stdout: string): AgentResult {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(RESULT_LINE_REGEX);
    if (!m) continue;
    const kind = m[1]!.toLowerCase() as "fixed" | "skipped" | "error";
    const detail = (m[2] ?? "").trim();
    if (kind === "fixed")   return { kind: "fixed",   summary: detail };
    if (kind === "skipped") return { kind: "skipped", reason:  detail };
    return { kind: "error", note: detail };
  }
  return { kind: "unrecognized" };
}
