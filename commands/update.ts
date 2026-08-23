#!/usr/bin/env bun

/**
 * rt update — asks mattstack.app (Sparkle) to check for an update.
 *
 * rt does not download or install its own updates; the app owns that whole
 * lifecycle (signature verification, staged install, restart). This verb is
 * a thin `POST /update/check` over tray.sock — the exact route the app's
 * "Check for Updates…" menu item triggers — so the CLI and the menu bar stay
 * one code path.
 */

import type { CommandContext } from "../lib/command-tree.ts";
import { trayRequest } from "../lib/daemon-client.ts";
import { currentMode as realCurrentMode } from "../lib/dev-mode.ts";
import { envelope } from "../lib/setup/contract.ts";

export const RELEASES_URL = "https://github.com/m4ttstack/rt/releases/latest";

export interface UpdateDeps {
  /** POSTs `/update/check` over tray.sock; `null` means the app isn't running (never throws). */
  tray: (endpoint: string, method: "GET" | "POST") => Promise<{ ok: boolean; error?: string } | null>;
  currentMode: () => "dev" | "prod";
  log: (line: string) => void;
  exit: (code: number) => never;
}

async function realTray(endpoint: string, method: "GET" | "POST"): Promise<{ ok: boolean; error?: string } | null> {
  const res = await trayRequest<{ ok: boolean; error?: string }>(endpoint, { method });
  if (res.status === 0) return null;
  if (res.json && typeof res.json.ok === "boolean") return res.json;
  return { ok: false, error: `unexpected response (status ${res.status})` };
}

export const realDeps: UpdateDeps = {
  tray: realTray,
  currentMode: realCurrentMode,
  log: (line) => console.log(line),
  exit: process.exit,
};

function printError(deps: UpdateDeps, json: boolean, code: string, message: string): void {
  deps.log(json ? JSON.stringify(envelope({ error: { code, message } })) : message);
  deps.exit(2);
}

export async function runUpdate(args: string[], _ctx: CommandContext = {}, deps: UpdateDeps = realDeps): Promise<void> {
  const json = args.includes("--json");

  if (deps.currentMode() === "dev") {
    printError(deps, json, "dev-mode", "dev mode is active — switch to prod first: rt settings dev-mode prod");
    return;
  }

  const res = await deps.tray("/update/check", "POST");

  if (res === null) {
    printError(
      deps,
      json,
      "app-not-running",
      `Updates come from mattstack.app (Sparkle). Open the app to check, or download the latest DMG: ${RELEASES_URL}`,
    );
    return;
  }

  if (!res.ok) {
    printError(
      deps,
      json,
      "app-too-old",
      `this mattstack.app can't be asked from the CLI (${res.error}) — use the menu bar: mattstack → Check for Updates…`,
    );
    return;
  }

  deps.log(json ? JSON.stringify(envelope({ asked: true })) : "asked mattstack.app to check for updates (Sparkle) — watch the menu bar");
}
