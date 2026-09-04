/**
 * `linear.mcp` adds ONE `mcpServers` entry, named `linear`, to Claude
 * Code's config so the pack skills' `mcp__linear__*` calls resolve on a
 * machine that never configured one by hand.
 *
 * This is the deliberate, scoped exception to plugins.install's rule that the
 * installer never touches ~/.claude.json: that rule still holds for
 * plugins.install itself, and this step touches nothing else in the file.
 * An entry already named `linear` is left exactly as it is, whatever it is.
 */
import type { StepOutcome, StepDef, ApplyContext } from "../apply.ts";
import { toFailedOutcome } from "./step-utils.ts";
import { claudeJsonPath, nameTaken, readClaudeConfig, withLinearEntry, writeClaudeConfig } from "../linear-mcp.ts";

async function linearMcpRun(ctx: ApplyContext): Promise<StepOutcome> {
  const path = claudeJsonPath(ctx.p);
  const read = readClaudeConfig(ctx.p, path);
  if (!read.ok && read.reason === "unparsable") {
    return { state: "failed", detail: `${path} is not valid JSON`, remedy: "Fix or remove that file, then Retry." };
  }
  const config = read.ok ? read.config : {};
  if (nameTaken(config)) return { state: "skipped", detail: "already configured" };

  const key = await ctx.secretPresence.has("rt", "linearApiKey");
  if (key === null) return { state: "skipped", detail: "no Linear key stored (connect Linear, then Retry)" };
  ctx.redact(key);

  writeClaudeConfig(ctx.p, path, withLinearEntry(config, key));
  ctx.log("linear.mcp", `added linear to ${path}`);
  return { state: "done", detail: `added linear to ${path}` };
}

export async function installLinearMcp(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await linearMcpRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const linearMcpStep: StepDef = {
  id: "linear.mcp",
  title: "Configure Linear MCP",
  kind: "rt",
  applies: () => true,
  run: installLinearMcp,
};
