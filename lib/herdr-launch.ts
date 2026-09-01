/**
 * Herdr pane launcher.
 *
 * Launches a batch of commands into split herdr panes by shelling out to
 * the `herdr` CLI binary (no daemon dependency). Falls back to running
 * items sequentially in the current process when not inside a herdr session.
 */
import { execSync } from "child_process";
import { decidePlacement } from "../packages/rt-client/src/smart-pane.ts";
import { green, dim, red, reset, bold } from "./tui.ts";

export interface LaunchItem {
  label: string;
  command: string;
  cwd: string;
}

export function isInsideHerdr(): boolean {
  return process.env.HERDR_ENV === "1";
}

export function getSelfPaneId(): string {
  // HERDR_PANE_ID is set by herdr itself and is authoritative; the focused-pane
  // lookup below is a fallback for older herdr versions that don't set it.
  const fromEnv = process.env.HERDR_PANE_ID;
  if (fromEnv) return fromEnv;
  const raw = execSync("herdr pane list", { encoding: "utf8", stdio: "pipe" });
  const parsed = JSON.parse(raw);
  const panes: Array<{ pane_id: string; focused: boolean }> = parsed.result?.panes ?? parsed.panes ?? [];
  const focused = panes.find((p) => p.focused);
  if (!focused) throw new Error("Could not determine focused herdr pane");
  return focused.pane_id;
}

export type HerdrExec = (cmd: string) => string;

const defaultExec: HerdrExec = (cmd) => execSync(cmd, { encoding: "utf8", stdio: "pipe" });

/** The parent pane's real rect, or null on any lookup/parse failure (decidePlacement then falls back to a right split). */
function parentRect(parentPaneId: string, exec: HerdrExec): { width: number; height: number } | null {
  try {
    const parsed = JSON.parse(exec(`herdr pane layout --pane ${parentPaneId}`));
    const panes: Array<{ pane_id: string; rect?: { width: number; height: number } }> = parsed.result?.layout?.panes ?? [];
    const rect = panes.find((p) => p.pane_id === parentPaneId)?.rect;
    return rect ? { width: rect.width, height: rect.height } : null;
  } catch {
    return null;
  }
}

export function splitPane(parentPaneId: string, exec: HerdrExec = defaultExec): string {
  const placement = decidePlacement(parentRect(parentPaneId, exec));
  if (placement.kind === "split") {
    const raw = exec(`herdr pane split ${parentPaneId} --direction ${placement.direction} --no-focus`);
    const newId = JSON.parse(raw).result?.pane?.pane_id;
    if (!newId) throw new Error("herdr pane split did not return a pane_id");
    return newId;
  }
  const workspaceId = parentPaneId.split(":")[0];
  const raw = exec(`herdr tab create --workspace ${workspaceId} --no-focus`);
  const newId = JSON.parse(raw).result?.root_pane?.pane_id;
  if (!newId) throw new Error("herdr tab create did not return a pane_id");
  return newId;
}

export function shellQuote(s: string): string {
  // If the string is clean (no special chars), return as-is
  if (/^[a-zA-Z0-9_./:@=-]+$/.test(s)) return s;
  // Otherwise wrap in single quotes, escaping internal single quotes
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function runInPane(paneId: string, command: string, cwd: string): void {
  const fullCmd = `cd ${shellQuote(cwd)} && ${command}`;
  // shellQuote, not JSON.stringify: JSON's double quotes still let the outer
  // shell expand $VAR/$(...)/backticks inside the user's command string.
  execSync(`herdr pane run ${paneId} ${shellQuote(fullCmd)}`, { stdio: "pipe" });
}

export async function launchInHerdr(items: LaunchItem[]): Promise<void> {
  if (items.length === 0) return;

  const selfPaneId = getSelfPaneId();

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    try {
      if (i === 0) {
        runInPane(selfPaneId, item.command, item.cwd);
        process.stderr.write(`  ${green}▸${reset} ${item.label} ${dim}(${selfPaneId})${reset}\n`);
      } else {
        const newPaneId = splitPane(selfPaneId);
        runInPane(newPaneId, item.command, item.cwd);
        process.stderr.write(`  ${green}▸${reset} ${item.label} ${dim}(${newPaneId})${reset}\n`);
      }
    } catch (err) {
      process.stderr.write(`  ${red}✗${reset} ${item.label}: ${err}\n`);
    }
  }

  process.stderr.write(`\n  ${green}${bold}✓${reset} ${dim}${items.length} pane${items.length > 1 ? "s" : ""} opened${reset}\n`);
}

export function launchFallback(items: LaunchItem[]): void {
  process.stderr.write(`\n  ${dim}Not inside herdr, running sequentially${reset}\n\n`);
  for (const item of items) {
    process.stderr.write(`  ${bold}${item.label}${reset}\n`);
    const result = Bun.spawnSync(["sh", "-c", item.command], {
      cwd: item.cwd,
      stdio: ["inherit", "inherit", "inherit"],
    });
    if (result.exitCode !== 0) {
      process.stderr.write(`  ${red}✗${reset} ${item.label} exited ${result.exitCode}\n`);
    }
  }
}
