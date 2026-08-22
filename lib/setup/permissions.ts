/**
 * Tray-permissions merge — GET /permissions on tray.sock, folded into the
 * perm.* plan rows. Every branch below treats a non-200 tray reply (socket
 * absent, mattstack.app not running, a stale build) as PermissionsReply|null
 * and reports "error"/"skipped", never inferring "ready" from silence
 * (RULING R-T4b honesty).
 */

import type { TrayClient } from "../daemon-client.ts";
import { row, type Action, type Row } from "./contract.ts";

export interface PermissionsReply {
  fda: { status: "granted" | "denied" | "unknown"; detail?: string };
  notifications: { status: "authorized" | "denied" | "notDetermined" | "provisional" };
  loginItems: { status: "enabled" | "requiresApproval" | "notRegistered" | "notFound" };
}

export async function fetchPermissions(tray: TrayClient): Promise<PermissionsReply | null> {
  const res = await tray("/permissions", { method: "GET" });
  if (res.status !== 200) return null;
  return res.json as PermissionsReply;
}

const RECHECK_ACTION: Action = { type: "run", label: "Re-check", verb: ["setup", "status"] };
const NOT_RUNNING_DETAIL = "mattstack.app not running — permission status unavailable";

const FDA_SETTINGS_ACTION: Action = { type: "open-settings", label: "Open Full Disk Access Settings…", target: "fda" };
const LOGIN_ITEMS_SETTINGS_ACTION: Action = { type: "open-settings", label: "Open Login Items…", target: "login-items" };
const NOTIFICATIONS_REQUEST_ACTION: Action = { type: "request-permission", label: "Allow", which: "notifications" };
const NOTIFICATIONS_SETTINGS_ACTION: Action = { type: "open-settings", label: "Open Notification Settings…", target: "notifications" };

function fdaRow(reply: PermissionsReply | null, daemonTcc: { blocked: number; total: number } | null): Row {
  const base = {
    id: "perm.fda",
    kind: "permission" as const,
    title: "Full Disk Access",
    why: "Reads your repositories' git state so the daemon can show branch and MR status.",
    required: true,
    recheck: "on-activate" as const,
  };

  if (reply?.fda.status === "granted") return row({ ...base, status: "ready", detail: "Granted" });
  if (reply?.fda.status === "denied") return row({ ...base, status: "needs-you", detail: "Not granted", action: FDA_SETTINGS_ACTION });
  if (reply?.fda.status === "unknown") return row({ ...base, status: "needs-you", detail: "Could not verify", action: FDA_SETTINGS_ACTION });

  // reply is null past here — fall back to what the daemon itself observed.
  if (daemonTcc && daemonTcc.blocked === 0 && daemonTcc.total > 0) {
    return row({ ...base, status: "ready", detail: `Daemon reads all ${daemonTcc.total} repos (checked via the daemon)` });
  }
  if (daemonTcc && daemonTcc.blocked > 0) {
    return row({ ...base, status: "needs-you", detail: "Not granted", action: FDA_SETTINGS_ACTION });
  }
  return row({ ...base, status: "error", detail: NOT_RUNNING_DETAIL, action: RECHECK_ACTION });
}

function loginItemsRow(reply: PermissionsReply | null): Row {
  const base = {
    id: "perm.login-items",
    kind: "permission" as const,
    title: "Login Items",
    why: "Lets mattstack.app start automatically and stay running in the background.",
    required: true,
    recheck: "on-activate" as const,
  };

  switch (reply?.loginItems.status) {
    case "enabled":
      return row({ ...base, status: "ready", detail: "Enabled" });
    case "requiresApproval":
      return row({ ...base, status: "needs-you", detail: "Approve in Login Items", action: LOGIN_ITEMS_SETTINGS_ACTION });
    case "notRegistered":
    case "notFound":
      return row({ ...base, status: "missing", detail: "Not registered yet (Install registers it)", action: null });
    default:
      return row({ ...base, status: "error", detail: NOT_RUNNING_DETAIL, action: RECHECK_ACTION });
  }
}

function notificationsRow(reply: PermissionsReply | null): Row {
  const base = {
    id: "perm.notifications",
    kind: "permission" as const,
    title: "Notifications",
    why: "Shows menu-bar notifications when something needs your attention.",
    required: false,
    optionalNote: "Works without this; you'll see menu-bar badges instead.",
    recheck: "on-activate" as const,
  };

  switch (reply?.notifications.status) {
    case "authorized":
    case "provisional":
      return row({ ...base, status: "ready", detail: "Allowed" });
    case "notDetermined":
      return row({ ...base, status: "needs-you", detail: "Not requested", action: NOTIFICATIONS_REQUEST_ACTION });
    case "denied":
      return row({ ...base, status: "needs-you", detail: "Denied", action: NOTIFICATIONS_SETTINGS_ACTION });
    default:
      return row({ ...base, status: "skipped", detail: "not checked (app not running)" });
  }
}

export function permissionRows(reply: PermissionsReply | null, daemonTcc: { blocked: number; total: number } | null): Row[] {
  return [fdaRow(reply, daemonTcc), loginItemsRow(reply), notificationsRow(reply)];
}
