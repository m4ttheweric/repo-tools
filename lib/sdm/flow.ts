/**
 * The guided connect flow, decoupled from any UI. The CLI passes prompt
 * functions backed by the terminal; the daemon's reconnect handler passes
 * interactive: false with prompts that are never reached.
 *
 * Org-visibility invariant: requestAccess reasons and durations come from a
 * human: typed at a prompt, passed as explicit flags, or authored once in
 * ~/.rt/sdm/enrichment.jsonc (reasonSuggestion). Non-interactive callers
 * default to the enrichment reason; no caller synthesizes a bespoke reason
 * at runtime.
 */

import { SDM_DEFAULT_DURATION, type SdmFailureCode, type SdmSnapshot } from "./core.ts";
import { buildPostgresUrl, type ProbeResult, type VerifyOutcome } from "./verify.ts";

export interface GuidedTarget {
  key: string;
  label: string;
  sdmResource: string;
  tier?: string;
  production?: boolean;
  reasonSuggestion?: string;
  db?: { database?: string; schema?: string; user?: string };
}

export interface GuidedDeps {
  getSnapshot: (force?: boolean) => Promise<SdmSnapshot>;
  needsAccessRequest: (resource: string) => Promise<boolean>;
  requestAccess: (
    resource: string, duration: string, reason: string, onLine: (l: string) => void,
  ) => Promise<{ ok: boolean; error?: string; code?: SdmFailureCode }>;
  connect: (
    resource: string, onLine: (l: string) => void,
  ) => Promise<{ ok: boolean; error?: string; code?: SdmFailureCode }>;
  verify: (url: string) => Promise<VerifyOutcome>;
  probeTunnel: (address: string) => Promise<ProbeResult>;
  login: (onLine: (l: string) => void) => Promise<{ ok: boolean; error?: string }>;
  promptDuration: (def: string) => Promise<string>;
  promptReason: (def: string) => Promise<string>;
  confirmProduction: (target: GuidedTarget) => Promise<boolean>;
  confirmLogin: () => Promise<boolean>;
  onLine: (line: string) => void;
  recordRecent: (target: GuidedTarget) => void;
}

export interface GuidedOptions {
  duration?: string;
  reason?: string;
  interactive: boolean;
}

export type GuidedResult =
  | { outcome: "connected"; address: string; verify: VerifyOutcome; unverified?: boolean }
  | { outcome: "aborted"; reason: string }
  | { outcome: "failed"; stage: "health" | "login" | "access" | "connect" | "verify"; error: string; hint?: string };

function hintFor(code?: SdmFailureCode): string | undefined {
  if (code === "not-authenticated") return "Run `rt sdm login`, then retry.";
  if (code === "no-access") return "Check the resource name, or request access with a reason.";
  return undefined;
}

export async function runGuidedConnect(
  target: GuidedTarget,
  opts: GuidedOptions,
  deps: GuidedDeps,
): Promise<GuidedResult> {
  let snapshot = await deps.getSnapshot();
  if (snapshot.health.status === "not-installed" || snapshot.health.status === "error") {
    return { outcome: "failed", stage: "health", error: snapshot.health.message ?? "StrongDM CLI unavailable." };
  }
  if (snapshot.health.status === "not-authenticated") {
    if (!opts.interactive) {
      return { outcome: "failed", stage: "login", error: snapshot.health.message ?? "Not authenticated." };
    }
    if (!(await deps.confirmLogin())) return { outcome: "aborted", reason: "login declined" };
    const login = await deps.login(deps.onLine);
    if (!login.ok) return { outcome: "failed", stage: "login", error: login.error ?? "Login failed." };
    snapshot = await deps.getSnapshot(true);
    if (snapshot.health.status !== "ok") {
      return { outcome: "failed", stage: "login", error: snapshot.health.message ?? "Still not authenticated." };
    }
  }

  if (await deps.needsAccessRequest(target.sdmResource)) {
    if (target.production && opts.interactive && !(await deps.confirmProduction(target))) {
      return { outcome: "aborted", reason: "production connect declined" };
    }
    let duration = opts.duration;
    let reason = opts.reason;
    if (opts.interactive) {
      duration ??= await deps.promptDuration(SDM_DEFAULT_DURATION);
      reason ??= await deps.promptReason(target.reasonSuggestion ?? `investigating ${target.label} data`);
    }
    duration ??= SDM_DEFAULT_DURATION;
    if (!reason?.trim()) reason = target.reasonSuggestion ?? `investigating ${target.label} data`;
    const access = await deps.requestAccess(target.sdmResource, duration, reason, deps.onLine);
    if (!access.ok) {
      return { outcome: "failed", stage: "access", error: access.error ?? "Access request failed.", hint: hintFor(access.code) };
    }
  }

  // Always connect: `sdm status` lies after sleep/gateway restarts, and
  // connectResource treats "already connected" as success.
  const conn = await deps.connect(target.sdmResource, deps.onLine);
  if (!conn.ok) {
    return { outcome: "failed", stage: "connect", error: conn.error ?? "Connect failed.", hint: hintFor(conn.code) };
  }

  const fresh = await deps.getSnapshot(true);
  const address = fresh.resources.get(target.sdmResource)?.address ?? null;
  if (!address) {
    return {
      outcome: "failed",
      stage: "verify",
      error: `sdm reports no local address for ${target.sdmResource} after connect.`,
    };
  }
  const url = buildPostgresUrl(address, target.db);
  const verify = await deps.verify(url);
  if (!verify.ok) {
    // SELECT 1 flaked. A freshly-connected sdm tunnel can leave its first
    // queries failing transiently ("Connection closed") while the tunnel is up
    // and usable. Distinguish a dead tunnel from an inconclusive probe: if TCP
    // is reachable, treat it as connected-with-warning (record + succeed)
    // rather than a hard failure telling the user to reconnect.
    const tcp = await deps.probeTunnel(address);
    if (tcp.ok) {
      deps.recordRecent(target);
      return { outcome: "connected", address, verify, unverified: true };
    }
    return {
      outcome: "failed",
      stage: "verify",
      error: `Tunnel is not reachable: ${verify.lastError?.message ?? "unknown error"}`,
      hint: "Reconnect with `rt sdm`, or check the resource in the StrongDM app.",
    };
  }
  deps.recordRecent(target);
  return { outcome: "connected", address, verify };
}
