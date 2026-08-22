import { describe, test, expect } from "bun:test";
import { fetchPermissions, permissionRows, type PermissionsReply } from "../permissions.ts";
import { fakeTray } from "./fakes.ts";

function reply(overrides: Partial<PermissionsReply>): PermissionsReply {
  return {
    fda: { status: "granted" },
    notifications: { status: "authorized" },
    loginItems: { status: "enabled" },
    ...overrides,
  };
}

function pickRow(rows: ReturnType<typeof permissionRows>, id: string) {
  const r = rows.find((row) => row.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

describe("fetchPermissions", () => {
  test("parses the body on a 200", async () => {
    const body = reply({});
    const tray = fakeTray({ "GET /permissions": () => ({ status: 200, json: body }) });
    expect(await fetchPermissions(tray)).toEqual(body);
  });

  test("non-200 (tray absent, unreachable, or app not yet serving) is null, never a guessed reply", async () => {
    const tray = fakeTray({});
    expect(await fetchPermissions(tray)).toBeNull();

    const tray500 = fakeTray({ "GET /permissions": () => ({ status: 500, json: { oops: true } }) });
    expect(await fetchPermissions(tray500)).toBeNull();
  });
});

describe("permissionRows — perm.fda", () => {
  test("granted -> ready, no action", () => {
    const r = pickRow(permissionRows(reply({ fda: { status: "granted" } }), null), "perm.fda");
    expect(r.status).toBe("ready");
    expect(r.detail).toBe("Granted");
    expect(r.action).toBeNull();
    expect(r.required).toBe(true);
    expect(r.kind).toBe("permission");
    expect(r.recheck).toBe("on-activate");
  });

  test("denied -> needs-you, open Full Disk Access settings", () => {
    const r = pickRow(permissionRows(reply({ fda: { status: "denied" } }), null), "perm.fda");
    expect(r.status).toBe("needs-you");
    expect(r.action).toEqual({ type: "open-settings", label: "Open Full Disk Access Settings…", target: "fda" });
  });

  test("unknown -> needs-you, same settings action", () => {
    const r = pickRow(permissionRows(reply({ fda: { status: "unknown" } }), null), "perm.fda");
    expect(r.status).toBe("needs-you");
    expect(r.action?.type).toBe("open-settings");
  });

  test("reply null, daemonTcc all-clear -> ready via the daemon", () => {
    const r = pickRow(permissionRows(null, { blocked: 0, total: 12 }), "perm.fda");
    expect(r.status).toBe("ready");
    expect(r.detail).toContain("12");
    expect(r.detail).toContain("daemon");
  });

  test("reply null, daemonTcc has blocked repos -> needs-you", () => {
    const r = pickRow(permissionRows(null, { blocked: 3, total: 12 }), "perm.fda");
    expect(r.status).toBe("needs-you");
    expect(r.action?.type).toBe("open-settings");
  });

  test("reply null, no daemonTcc signal -> error, never invalid or ready", () => {
    const r = pickRow(permissionRows(null, null), "perm.fda");
    expect(r.status).toBe("error");
    expect(r.detail).toBe("mattstack.app not running — permission status unavailable");
    expect(r.action).toEqual({ type: "run", label: "Re-check", verb: ["setup", "status"] });
  });
});

describe("permissionRows — perm.login-items", () => {
  test("enabled -> ready", () => {
    const r = pickRow(permissionRows(reply({ loginItems: { status: "enabled" } }), null), "perm.login-items");
    expect(r.status).toBe("ready");
    expect(r.required).toBe(true);
  });

  test("requiresApproval -> needs-you, open Login Items settings", () => {
    const r = pickRow(permissionRows(reply({ loginItems: { status: "requiresApproval" } }), null), "perm.login-items");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toBe("Approve in Login Items");
    expect(r.action).toEqual({ type: "open-settings", label: "Open Login Items…", target: "login-items" });
  });

  test("notRegistered -> missing, no action (Install registers it)", () => {
    const r = pickRow(permissionRows(reply({ loginItems: { status: "notRegistered" } }), null), "perm.login-items");
    expect(r.status).toBe("missing");
    expect(r.detail).toBe("Not registered yet (Install registers it)");
    expect(r.action).toBeNull();
  });

  test("notFound -> missing, no action", () => {
    const r = pickRow(permissionRows(reply({ loginItems: { status: "notFound" } }), null), "perm.login-items");
    expect(r.status).toBe("missing");
    expect(r.action).toBeNull();
  });

  test("reply null -> error, re-check action", () => {
    const r = pickRow(permissionRows(null, null), "perm.login-items");
    expect(r.status).toBe("error");
    expect(r.action?.type).toBe("run");
  });
});

describe("permissionRows — perm.notifications", () => {
  test("authorized -> ready, optional row with a note", () => {
    const r = pickRow(permissionRows(reply({ notifications: { status: "authorized" } }), null), "perm.notifications");
    expect(r.status).toBe("ready");
    expect(r.required).toBe(false);
    expect(r.optionalNote).toBe("Works without this; you'll see menu-bar badges instead.");
  });

  test("provisional -> ready", () => {
    const r = pickRow(permissionRows(reply({ notifications: { status: "provisional" } }), null), "perm.notifications");
    expect(r.status).toBe("ready");
  });

  test("notDetermined -> needs-you, request-permission action", () => {
    const r = pickRow(permissionRows(reply({ notifications: { status: "notDetermined" } }), null), "perm.notifications");
    expect(r.status).toBe("needs-you");
    expect(r.detail).toBe("Not requested");
    expect(r.action).toEqual({ type: "request-permission", label: "Allow", which: "notifications" });
  });

  test("denied -> needs-you, open Notification settings", () => {
    const r = pickRow(permissionRows(reply({ notifications: { status: "denied" } }), null), "perm.notifications");
    expect(r.status).toBe("needs-you");
    expect(r.action).toEqual({ type: "open-settings", label: "Open Notification Settings…", target: "notifications" });
  });

  test("reply null -> skipped, never invalid, not required", () => {
    const r = pickRow(permissionRows(null, null), "perm.notifications");
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("not checked (app not running)");
    expect(r.required).toBe(false);
  });
});
