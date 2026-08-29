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

/**
 * Every resolvable session id in one pass over the registry roots -- the
 * batch form callers with more than one lookup (a buddy roster, a sign-in
 * transaction's suffix scan) must use instead of calling `resolveInbox` once
 * per id, or each of those becomes its own directory read. First match wins
 * per session id, same root/file order `resolveInbox` itself walks, so a
 * duplicate entry across roots resolves identically either way.
 */
export function resolveAllInboxes(opts?: { roots?: string[] }): Map<string, InboxBinding> {
  const map = new Map<string, InboxBinding>();
  for (const root of opts?.roots ?? registryRoots()) {
    let files: string[];
    try { files = readdirSync(root); } catch { continue; }
    for (const f of files) {
      if (!/^\d+\.json$/.test(f)) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(join(root, f), "utf8")); } catch { continue; }
      // JSON.parse accepts any value -- a bare `null` or a number is valid
      // JSON but not a record, and property access below would throw past
      // the try/catch above.
      if (typeof parsed !== "object" || parsed === null) continue;
      const entry = parsed as Record<string, unknown>;
      if (typeof entry.sessionId !== "string") continue;
      if (typeof entry.pid !== "number" || typeof entry.messagingSocketPath !== "string") continue;
      if (map.has(entry.sessionId)) continue;
      const status = typeof entry.status === "string" && STATUSES.has(entry.status) ? (entry.status as InboxBinding["status"]) : undefined;
      map.set(entry.sessionId, { pid: entry.pid, socketPath: entry.messagingSocketPath, status, name: typeof entry.name === "string" ? entry.name : undefined });
    }
  }
  return map;
}

export function resolveInbox(sessionId: string, opts?: { roots?: string[] }): InboxBinding | null {
  return resolveAllInboxes(opts).get(sessionId) ?? null;
}

export function inboxAlive(b: InboxBinding): boolean {
  try { process.kill(b.pid, 0); } catch { return false; }
  return existsSync(b.socketPath);
}
