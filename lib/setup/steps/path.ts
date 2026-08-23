/**
 * `path.link` — exposes rt's default tool set on PATH (T5's tagged links)
 * and wires shell integration + PATH precedence so a fresh shell picks them
 * up without a manual `source`.
 */

import { readFileSync, writeFileSync } from "fs";
import { DEFAULT_EXPOSED, link } from "../../deps/links.ts";
import { detectShell, installShellIntegration, installZshenvPrecedence, shellRcPath } from "../../shell-integration.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";
import { toFailedOutcome } from "./step-utils.ts";

/**
 * The v0.x shell wrapper used `command -v rt` to resolve the binary path. In
 * zsh, `command -v rt` returns the function name (not the binary path), so
 * `rt_bin="rt"` and every call recurses until FUNCNEST blows up. A machine
 * whose rc file still has the broken text (written before this fix existed,
 * and `installShellIntegration()` above is a no-op once a marker is already
 * present) needs this one-time text repair; a fresh write from
 * `installShellIntegration()` already has the fix and never matches.
 * Log-only: never fails the step over a single-file text edit.
 */
function repairShellWrapper(): boolean {
  const shell = detectShell();
  const rcPath = shellRcPath(shell);
  if (!rcPath) return false;

  let content: string;
  try {
    content = readFileSync(rcPath, "utf8");
  } catch {
    return false;
  }

  if (!content.includes("rt() {") || !content.includes("command -v rt") || content.includes("whence -p rt")) return false;

  const broken = '  [ -x "$rt_bin" ] || rt_bin="$(command -v rt 2>/dev/null || echo rt)"';
  const fixed = [
    '  # whence -p (zsh) / type -P (bash): PATH-only lookup, skips this function',
    '  [ -x "$rt_bin" ] || rt_bin="$(whence -p rt 2>/dev/null || type -P rt 2>/dev/null)"',
    '  [ -x "$rt_bin" ] || { echo "rt: binary not found in PATH" >&2; return 1; }',
  ].join("\n");

  const repaired = content.replace(broken, fixed);
  // Exact-string replace: if the rc line differs (hand-edited whitespace),
  // nothing changed — don't rewrite the file or claim a repair happened.
  if (repaired === content) return false;
  writeFileSync(rcPath, repaired);
  return true;
}

async function pathLinkRun(ctx: ApplyContext): Promise<StepOutcome> {
  const linked: string[] = [];
  const skipped: string[] = [];

  for (const tool of DEFAULT_EXPOSED) {
    const outcome = link(ctx.p, tool);
    if (outcome.ok) {
      linked.push(tool);
    } else {
      // dev-mode-owns-rt, user-copy, occupied, no-bundle — none of these
      // fail the step; each is a per-tool skip with an honest log line.
      skipped.push(tool);
      ctx.log("path.link", outcome.detail);
    }
  }

  // Neither of these throws (installZshenvPrecedence wraps its own fs calls)
  // — their symlinks above have already landed either way, so a rc-file
  // problem here is reported honestly in the detail rather than silently
  // dropped or turned into a step failure that would undo real progress.
  const notes: string[] = [];

  const shellResult = installShellIntegration();
  if (!shellResult.written && !shellResult.alreadyInstalled) {
    const note = `shell integration not installed (${shellResult.shell}): ${shellResult.error ?? "unknown reason"}`;
    ctx.log("path.link", note);
    notes.push(note);
  }

  const zshenvResult = installZshenvPrecedence();
  if (!zshenvResult.written && !zshenvResult.alreadyInstalled) {
    const note = `~/.zshenv PATH precedence not installed: ${zshenvResult.error ?? "unknown reason"}`;
    ctx.log("path.link", note);
    notes.push(note);
  }

  if (repairShellWrapper()) ctx.log("path.link", "repaired shell wrapper FUNCNEST recursion bug");

  const base = `linked: ${linked.length > 0 ? linked.join(", ") : "none"} · skipped: ${skipped.length > 0 ? skipped.join(", ") : "none"}`;
  return { state: "done", detail: notes.length > 0 ? `${base} · ${notes.join(" · ")}` : base };
}

async function pathLinkRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await pathLinkRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const pathLinkStep: StepDef = {
  id: "path.link",
  title: "Link rt onto your PATH",
  kind: "rt",
  applies: () => true,
  run: pathLinkRunSafe,
};
