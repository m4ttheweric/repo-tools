/**
 * Herdr pane launcher.
 *
 * Launches a batch of commands into split herdr panes by shelling out to
 * the `herdr` CLI binary (no daemon dependency). Falls back to running
 * items sequentially in the current process when not inside a herdr session.
 */
import { execSync } from "child_process";
import { green, dim, red, reset, bold } from "./tui.ts";

export interface LaunchItem {
  label: string;
  command: string;
  cwd: string;
}

export function isInsideHerdr(): boolean {
  return process.env.HERDR_ENV === "1";
}

function getSelfPaneId(): string {
  const raw = execSync("herdr pane list", { encoding: "utf8", stdio: "pipe" });
  const parsed = JSON.parse(raw);
  const panes: Array<{ pane_id: string; focused: boolean }> = parsed.result?.panes ?? parsed.panes ?? [];
  const focused = panes.find((p) => p.focused);
  if (!focused) throw new Error("Could not determine focused herdr pane");
  return focused.pane_id;
}

function pickSplitDirection(): "right" | "down" {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  return cols >= rows * 2 ? "right" : "down";
}

function splitPane(parentPaneId: string): string {
  const direction = pickSplitDirection();
  const raw = execSync(
    `herdr pane split ${parentPaneId} --direction ${direction} --no-focus`,
    { encoding: "utf8", stdio: "pipe" },
  );
  const parsed = JSON.parse(raw);
  const newId = parsed.result?.pane?.pane_id;
  if (!newId) throw new Error("herdr pane split did not return a pane_id");
  return newId;
}

function shellQuote(s: string): string {
  // If the string is clean (no special chars), return as-is
  if (/^[a-zA-Z0-9_./:@=-]+$/.test(s)) return s;
  // Otherwise wrap in single quotes, escaping internal single quotes
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function runInPane(paneId: string, command: string, cwd: string): void {
  const fullCmd = `cd ${shellQuote(cwd)} && ${command}`;
  execSync(`herdr pane run ${paneId} ${JSON.stringify(fullCmd)}`, { stdio: "pipe" });
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
