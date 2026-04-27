/**
 * Generic agent runner — pipe a prompt into a CLI agent via stdin,
 * stream its stdout to the caller while also capturing it for return.
 *
 * Default: `claude -p`. Agent-aware defaults cover Codex (`codex exec -`);
 * override via `cli` / `args` for other agents.
 *
 * Intentionally minimal — no prompt assembly, no config reading. Callers
 * build the prompt string; this just runs the CLI and streams.
 */

import { spawn } from "child_process";

export interface AgentOptions {
  /** Executable name. Default: "claude". */
  cli?: string;
  /** CLI args. Default: ["-p"] (non-interactive print mode). */
  args?: string[];
  /** The prompt text — piped to the CLI on stdin. */
  prompt: string;
  /** Working directory for the spawned CLI. */
  cwd?: string;
  /**
   * If set, each stdout chunk is written here as it arrives (in addition
   * to being captured in the returned `stdout`). Pass `process.stdout` to
   * stream the response live to the user's terminal.
   */
  stream?: NodeJS.WritableStream;
  /** Optional stderr sink for status / progress (e.g. `process.stderr`). */
  stderrStream?: NodeJS.WritableStream;
}

export interface AgentInvocation {
  cli: string;
  args: string[];
}

export interface AgentResult {
  stdout: string;
  stderr: string;
  ok: boolean;
  exitCode: number | null;
}

function defaultArgsForAgent(cli: string): string[] {
  const name = cli.split("/").pop() ?? cli;
  if (name === "codex") return ["exec", "-"];
  return ["-p"];
}

export function resolveAgentInvocation(opts: Pick<AgentOptions, "cli" | "args">): AgentInvocation {
  const cli = opts.cli ?? "claude";
  return {
    cli,
    args: opts.args ?? defaultArgsForAgent(cli),
  };
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const { cli, args } = resolveAgentInvocation(opts);

  return new Promise<AgentResult>((resolve, reject) => {
    const child = spawn(cli, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (opts.stream) opts.stream.write(chunk);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (opts.stderrStream) opts.stderrStream.write(chunk);
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, ok: code === 0, exitCode: code });
    });

    child.stdin.end(opts.prompt);
  });
}
