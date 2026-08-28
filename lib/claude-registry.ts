/**
 * Read-only view of Claude Code's on-disk session registries. The uuid in
 * chat presence rows IS Claude's session id (rt chat sign-in keys on
 * CLAUDE_CODE_SESSION_ID; daemon-side sign-in reads herdr's agent_session),
 * so a registry hit is the whole pane-to-inbox resolution.
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface InboxBinding {
  pid: number;
  socketPath: string;
  status: "busy" | "idle" | "shell" | undefined;
  name?: string;
}

export function registryRoots(): string[] {
  const home = homedir();
  const roots = [join(home, ".claude", "sessions")];
  const swap = join(home, ".claude-swap-backup", "sessions");
  try {
    for (const account of readdirSync(swap)) roots.push(join(swap, account, "sessions"));
  } catch { /* no cswap accounts */ }
  return roots;
}

const STATUSES = new Set(["busy", "idle", "shell"]);

export function resolveInbox(sessionId: string, opts?: { roots?: string[] }): InboxBinding | null {
  for (const root of opts?.roots ?? registryRoots()) {
    let files: string[];
    try { files = readdirSync(root); } catch { continue; }
    for (const f of files) {
      if (!/^\d+\.json$/.test(f)) continue;
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(readFileSync(join(root, f), "utf8")); } catch { continue; }
      if (entry.sessionId !== sessionId) continue;
      if (typeof entry.pid !== "number" || typeof entry.messagingSocketPath !== "string") continue;
      const status = typeof entry.status === "string" && STATUSES.has(entry.status) ? (entry.status as InboxBinding["status"]) : undefined;
      return { pid: entry.pid, socketPath: entry.messagingSocketPath, status, name: typeof entry.name === "string" ? entry.name : undefined };
    }
  }
  return null;
}

export function inboxAlive(b: InboxBinding): boolean {
  try { process.kill(b.pid, 0); } catch { return false; }
  return existsSync(b.socketPath);
}
