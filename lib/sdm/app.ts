/**
 * StrongDM desktop-app preflight. The sdm CLI is only a control surface;
 * tunnels live in the desktop app (/Applications/SDM.app and its privileged
 * helper). A CLI probe that errors while the app process is absent means the
 * app is down: launch it in the background and wait for the CLI to answer.
 *
 * Detection is a process check, never error-text matching: sdm's app-down
 * output is unverified and interpretSdmStatus could misread it.
 */

import { execFile } from "node:child_process";
import { getSdmSnapshot, type SdmSnapshot } from "./core.ts";

const APP_PROCESS = "SDM";
const APP_WAIT_ATTEMPTS = 15;
const APP_WAIT_INTERVAL_MS = 1_000;

function run(cmd: string, args: string[]): Promise<{ code: number }> {
  return new Promise(resolve => {
    execFile(cmd, args, err => resolve({ code: err ? 1 : 0 }));
  });
}

export async function isSdmAppRunning(): Promise<boolean> {
  return (await run("pgrep", ["-x", APP_PROCESS])).code === 0;
}

export interface EnsureAppDeps {
  getSnapshot: (force?: boolean) => Promise<SdmSnapshot>;
  isRunning: () => Promise<boolean>;
  launch: () => Promise<{ code: number }>;
  sleep: (ms: number) => Promise<void>;
}

export async function ensureSdmApp(
  onLine: (line: string) => void,
  deps: Partial<EnsureAppDeps> = {},
): Promise<{ ok: boolean; error?: string }> {
  const d: EnsureAppDeps = {
    getSnapshot: f => getSdmSnapshot(f),
    isRunning: isSdmAppRunning,
    launch: () => run("open", ["-ga", APP_PROCESS]),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    ...deps,
  };
  // Only "error" can mean the app is down: ok / not-authenticated mean the
  // CLI answered, and not-installed is a different problem entirely.
  const snapshot = await d.getSnapshot();
  if (snapshot.health.status !== "error") return { ok: true };
  if (await d.isRunning()) return { ok: true };
  onLine("StrongDM app is not running; launching it");
  const launched = await d.launch();
  if (launched.code !== 0) return { ok: false, error: "Could not launch the StrongDM app (`open -ga SDM` failed)." };
  for (let i = 0; i < APP_WAIT_ATTEMPTS; i++) {
    await d.sleep(APP_WAIT_INTERVAL_MS);
    const fresh = await d.getSnapshot(true);
    if (fresh.health.status !== "error") return { ok: true };
  }
  return { ok: false, error: `StrongDM app did not become ready within ${APP_WAIT_ATTEMPTS}s of launching.` };
}
