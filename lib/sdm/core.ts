/**
 * Org-agnostic StrongDM CLI mechanics: pure output parsers here; the spawn
 * wrapper, snapshot cache, and command helpers are added below them.
 *
 * The sdm CLI has no JSON output; everything is column-text parsing. The
 * pure functions are kept side-effect free so they test against captured
 * output verbatim.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";

export interface SdmResourceState {
  connected: boolean;
  address: string | null;
  expiry: string | null;
}

export interface SdmHealth {
  status: "ok" | "not-installed" | "not-authenticated" | "error";
  message: string | null;
}

export interface SdmSnapshot {
  health: SdmHealth;
  resources: Map<string, SdmResourceState>;
}

export type SdmFailureCode = "not-authenticated" | "no-access" | "other";

export const SDM_INSTALL_URL = "https://www.strongdm.com/docs/cli/";

const HEADER_FIRST_COL = new Set(["DATASOURCE", "CLUSTER", "WEBSITE", "SERVER"]);

export function parseSdmStatus(output: string): Map<string, SdmResourceState> {
  const resources = new Map<string, SdmResourceState>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s{2,}/);
    if (cols.length < 2) continue;
    const name = cols[0]!;
    if (HEADER_FIRST_COL.has(name)) continue;
    const statusRaw = (cols[1] ?? "").toLowerCase();
    const connected = statusRaw.includes("connected") && !statusRaw.includes("not connected");
    const addressCol = cols[2] ?? "";
    // sdm binds tunnels on loopback; anything else in this column is not a
    // usable local address (some rows carry the remote endpoint instead).
    const addressToken = addressCol.split(/\s+/)[0] ?? "";
    const address = addressToken.startsWith("127.") ? addressToken : null;
    const expiryMatch = trimmed.match(/ until (.+)$/);
    resources.set(name, { connected, address, expiry: expiryMatch?.[1] ?? null });
  }
  return resources;
}

function catalogRows(output: string): Array<{ name: string; cols: string[] }> {
  const rows: Array<{ name: string; cols: string[] }> = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s{2,}/);
    if (cols.length < 2 || !/^rs-[0-9a-f]+$/i.test(cols[0]!)) continue;
    rows.push({ name: cols[1]!.trim(), cols });
  }
  return rows;
}

export function catalogResourceNames(output: string): string[] {
  return catalogRows(output).map(r => r.name);
}

export function resourceNeedsAccessRequest(catalogOutput: string, resource: string): boolean {
  const row = catalogRows(catalogOutput).find(r => r.name === resource);
  if (!row) return false;
  return row.cols.some(c => c.trim().toLowerCase() === "available");
}

const NOT_AUTHENTICATED: SdmHealth = {
  status: "not-authenticated",
  message: "StrongDM CLI is not authenticated: run `sdm login` and try again.",
};

export function interpretSdmStatus(
  spawnErrorCode: string | null,
  exitCode: number | null,
  output: string,
): SdmHealth {
  if (spawnErrorCode === "ENOENT") {
    return { status: "not-installed", message: `StrongDM CLI not found. Install it from ${SDM_INSTALL_URL}.` };
  }
  if (spawnErrorCode === "ETIMEDOUT") {
    return { status: "error", message: "StrongDM CLI did not respond in time." };
  }
  if (spawnErrorCode) {
    return { status: "error", message: `Error running sdm (${spawnErrorCode}).` };
  }
  const lower = output.toLowerCase();
  const loggedOutText =
    lower.includes("not authenticated") || lower.includes("please log in") || lower.includes("please login");
  if (exitCode !== 0) {
    if (loggedOutText || /\blog ?in\b/.test(lower)) return NOT_AUTHENTICATED;
    return {
      status: "error",
      message: output.trim().slice(0, 200) || `sdm status exited with code ${exitCode}.`,
    };
  }
  // A logged-out CLI can exit 0 with a banner; the table header is the
  // reliable signal that a real status listing came back.
  const hasTableHeader = /\b(datasource|cluster|website|server)\b/i.test(output);
  if (loggedOutText || !hasTableHeader) return NOT_AUTHENTICATED;
  return { status: "ok", message: null };
}

export function classifySdmFailure(output: string): SdmFailureCode {
  const lower = output.toLowerCase();
  if (
    lower.includes("not authenticated") ||
    lower.includes("please log in") ||
    lower.includes("please login") ||
    lower.includes("sdm login") ||
    (lower.includes("token") && lower.includes("expired"))
  ) {
    return "not-authenticated";
  }
  if (/cannot find datasource|no resources matched|access denied|not authorized|permission denied/i.test(output)) {
    return "no-access";
  }
  return "other";
}

export function buildSdmSnapshot(
  spawnErrorCode: string | null,
  exitCode: number | null,
  output: string,
): SdmSnapshot {
  const health = interpretSdmStatus(spawnErrorCode, exitCode, output);
  return {
    health,
    resources: health.status === "ok" ? parseSdmStatus(output) : new Map(),
  };
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

function sdmBin(): string {
  return process.env.RT_SDM_BIN ?? "sdm";
}

/**
 * PATH fixup so daemon-spawned invocations (minimal launchd env) still find
 * a Homebrew- or vendor-installed sdm.
 */
export function sdmEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${home}/.sdm/bin`,
    `${home}/.local/bin`,
    "/usr/bin",
    "/bin",
  ].join(":");
  return { ...process.env, PATH: `${extra}:${process.env.PATH ?? ""}` };
}

export interface RunSdmResult {
  ok: boolean;
  output: string;
  timedOut?: boolean;
  spawnErrorCode: string | null;
  exitCode: number | null;
}

export function runSdmCommand(
  args: string[],
  onLine: (line: string) => void,
  opts: { timeoutMs?: number } = {},
): Promise<RunSdmResult> {
  return new Promise(resolve => {
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const settle = (r: RunSdmResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(r);
    };
    const proc = spawn(sdmBin(), args, { stdio: ["ignore", "pipe", "pipe"], env: sdmEnv() });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.stdout?.destroy();
          proc.stderr?.destroy();
          proc.kill(9); // SIGKILL
          // Safeguard: if process doesn't exit within 1s, force settle
          killTimer = setTimeout(() => {
            settle({
              ok: false,
              output,
              timedOut: true,
              spawnErrorCode: "ETIMEDOUT",
              exitCode: null,
            });
          }, 1000);
        }, opts.timeoutMs)
      : null;
    let output = "";
    const handle = (d: Buffer) => {
      const s = String(d);
      output += s;
      for (const line of s.split("\n")) if (line.trim()) onLine(line.trim());
    };
    proc.stdout?.on("data", handle);
    proc.stderr?.on("data", handle);
    proc.on("error", err =>
      settle({
        ok: false,
        output,
        spawnErrorCode: (err as NodeJS.ErrnoException).code ?? "EUNKNOWN",
        exitCode: null,
      }),
    );
    proc.on("close", code =>
      settle({
        ok: code === 0 && !timedOut,
        output,
        timedOut,
        spawnErrorCode: timedOut ? "ETIMEDOUT" : null,
        exitCode: code,
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// Snapshot + catalog caches
// ---------------------------------------------------------------------------

const SDM_STATUS_TIMEOUT_MS = 15_000;
const SNAPSHOT_CACHE_MS = 5_000;
let snapshotCache: { at: number; snapshot: SdmSnapshot } | null = null;

export function invalidateSdmSnapshotCache(): void {
  snapshotCache = null;
}

/**
 * One `sdm status` spawn feeds both CLI health and per-resource state.
 * 5s cache absorbs back-to-back callers; mutations invalidate explicitly.
 * A transient error gets one retry so a cold blip does not stick.
 */
export async function getSdmSnapshot(force = false): Promise<SdmSnapshot> {
  if (!force && snapshotCache && Date.now() - snapshotCache.at < SNAPSHOT_CACHE_MS) {
    return snapshotCache.snapshot;
  }
  let r = await runSdmCommand(["status"], () => {}, { timeoutMs: SDM_STATUS_TIMEOUT_MS });
  let snapshot = buildSdmSnapshot(r.spawnErrorCode, r.exitCode, r.output);
  if (snapshot.health.status === "error") {
    r = await runSdmCommand(["status"], () => {}, { timeoutMs: SDM_STATUS_TIMEOUT_MS });
    snapshot = buildSdmSnapshot(r.spawnErrorCode, r.exitCode, r.output);
  }
  snapshotCache = { at: Date.now(), snapshot };
  return snapshot;
}

const SDM_CATALOG_TIMEOUT_MS = 15_000;
const SDM_CATALOG_CACHE_MS = 10 * 60_000;
let catalogCache: { at: number; output: string } | null = null;

export function invalidateSdmCatalogCache(): void {
  catalogCache = null;
}

export async function fetchAccessCatalog(force = false): Promise<{ ok: boolean; output: string }> {
  if (!force && catalogCache && Date.now() - catalogCache.at < SDM_CATALOG_CACHE_MS) {
    return { ok: true, output: catalogCache.output };
  }
  const r = await runSdmCommand(["access", "catalog"], () => {}, { timeoutMs: SDM_CATALOG_TIMEOUT_MS });
  if (r.ok) catalogCache = { at: Date.now(), output: r.output };
  return { ok: r.ok, output: r.output };
}

// ---------------------------------------------------------------------------
// Mutations: access, connect, login
// ---------------------------------------------------------------------------

const SDM_ACCESS_TIMEOUT_MS = 60_000;
const SDM_CONNECT_TIMEOUT_MS = 60_000;
// SAML happens in the user's browser and takes as long as it takes; only a
// truly wedged CLI should trip this.
const SDM_LOGIN_TIMEOUT_MS = 180_000;

/**
 * Org-visible mutation: callers MUST have collected duration and reason from
 * a human before calling this. Never invoke it with synthesized values.
 */
export async function requestAccess(
  resource: string,
  duration: string,
  reason: string,
  onLine: (line: string) => void,
): Promise<{ ok: boolean; error?: string; code?: SdmFailureCode }> {
  const r = await runSdmCommand(
    ["access", "to", resource, "--duration", duration, "--reason", reason],
    onLine,
    { timeoutMs: SDM_ACCESS_TIMEOUT_MS },
  );
  if (!r.ok) {
    return { ok: false, error: `Access request failed: ${r.output.trim() || "unknown error"}`, code: classifySdmFailure(r.output) };
  }
  invalidateSdmSnapshotCache();
  invalidateSdmCatalogCache();
  return { ok: true };
}

export async function connectResource(
  resource: string,
  onLine: (line: string) => void,
): Promise<{ ok: boolean; error?: string; code?: SdmFailureCode }> {
  const r = await runSdmCommand(["connect", resource], onLine, { timeoutMs: SDM_CONNECT_TIMEOUT_MS });
  if (!r.ok && !r.output.includes("already connected")) {
    return { ok: false, error: `Connect failed: ${r.output.trim() || "unknown error"}`, code: classifySdmFailure(r.output) };
  }
  invalidateSdmSnapshotCache();
  return { ok: true };
}

export type RunSdm = typeof runSdmCommand;

/**
 * `sdm login` is prompt-driven (App Domain, email) even when already
 * authenticated, so it must not run with stdin ignored: the prompt hits EOF
 * and the login fails. In a terminal the right answer is full interactivity:
 * inherit stdio so the user answers prompts directly and sees SAML progress,
 * while we only enforce the timeout. Callers must ensure a TTY first.
 * Output cannot be captured with inherited stdio; the user already saw it.
 */
export function runSdmLoginInteractive(
  args: string[],
  _onLine: (line: string) => void,
  opts: { timeoutMs?: number } = {},
): Promise<RunSdmResult> {
  return new Promise(resolve => {
    let settled = false;
    let timedOut = false;
    const settle = (r: RunSdmResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const proc = spawn(sdmBin(), args, { stdio: "inherit", env: sdmEnv() });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    proc.on("error", err => {
      const code = (err as NodeJS.ErrnoException).code ?? "EUNKNOWN";
      settle({
        ok: false,
        output: code === "ENOENT" ? `StrongDM CLI not found. Install it from ${SDM_INSTALL_URL}.` : `Error running sdm (${code}).`,
        spawnErrorCode: code,
        exitCode: null,
      });
    });
    proc.on("close", code =>
      settle({
        ok: code === 0 && !timedOut,
        output: "",
        timedOut,
        spawnErrorCode: timedOut ? "ETIMEDOUT" : null,
        exitCode: code,
      }),
    );
  });
}

/** Seam for tests; production loginSdm binds the real interactive runner. */
export async function loginSdmWith(
  run: RunSdm,
  onLine: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const result = await run(["login"], onLine, { timeoutMs: SDM_LOGIN_TIMEOUT_MS });
  if (result.ok) return { ok: true };
  if (result.timedOut) {
    return {
      ok: false,
      error: "Login timed out. Complete the SAML flow in your browser, or run `sdm login` in a terminal.",
    };
  }
  return { ok: false, error: `Login failed: ${result.output.trim() || "the sdm CLI reported the details above"}` };
}

/** Run `sdm login` interactively in the user's terminal; sdm opens the browser for SAML. */
export async function loginSdm(onLine: (line: string) => void): Promise<{ ok: boolean; error?: string }> {
  const result = await loginSdmWith(runSdmLoginInteractive, onLine);
  if (result.ok) invalidateSdmSnapshotCache();
  return result;
}
