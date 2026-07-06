/**
 * rt sdm: StrongDM connections. `sdm` is a branch node (cli.ts); subcommands:
 *
 *   rt sdm connect [<key>] [--duration 8h] [--reason "..."]  SDM-first picker,
 *                                    or connect a key directly
 *   rt sdm status                   CLI health + connected tunnels
 *   rt sdm login [--manual] [--visible]   log in (default: browser popup flow)
 *   rt sdm refresh                  re-scan StrongDM, bust the cache
 *   rt sdm enrichment [init]        show, or scaffold, the declarative label/tier map
 *
 * The daemon serves the resource scan when running (10-minute cache);
 * everything falls back to in-process execution when it is not.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandContext } from "../lib/command-tree.ts";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import {
  connectResource,
  fetchAccessCatalog,
  getSdmSnapshot,
  loginSdm,
  requestAccess,
  resourceNeedsAccessRequest,
  SDM_INSTALL_URL,
} from "../lib/sdm/core.ts";
import { scanSdmResources, type SdmResource } from "../lib/sdm/scan.ts";
import { buildSdmConnections, type SdmConnection } from "../lib/sdm/browse.ts";
import { loadEnrichment } from "../lib/sdm/enrichment.ts";
import { loadSdmState, recordRecent, type RecentEntry } from "../lib/sdm/state.ts";
import { runGuidedConnect, type GuidedTarget } from "../lib/sdm/flow.ts";
import { probeQuery, verifyWithRetries, VERIFY_ATTEMPT_TIMEOUT_MS } from "../lib/sdm/verify.ts";
import { buildPickerOptions } from "../lib/sdm/picker.ts";

// `sdm` is a branch node in the command tree (cli.ts); each subcommand below
// is a leaf pointing at one of these exported functions.

// ── Scan access (daemon-first, in-process fallback) ──────────────────────

async function getScan(refresh = false): Promise<{ resources: SdmResource[]; error?: string }> {
  const { daemonQuery } = await import("../lib/daemon-client.ts");
  const result = await daemonQuery("sdm:catalog", refresh ? { refresh: true } : undefined, 45_000);
  if (result?.ok && Array.isArray((result as any).resources)) {
    const r = result as any;
    return { resources: r.resources as SdmResource[], error: r.error };
  }
  // Daemon unreachable, or still serving the pre-scan connector shape
  // (no `resources` array) until it is restarted onto the new handler.
  const scanned = await scanSdmResources({ refresh });
  return { resources: scanned.resources, error: scanned.error };
}

// ── Guided flow wiring (real prompts, real sdm) ──────────────────────────────

function streamLine(line: string): void {
  process.stderr.write(`  ${dim}${line}${reset}\n`);
}

/**
 * Log in to StrongDM: the browser popup first, falling back to the terminal
 * flow when the popup cannot run (no Chrome, email unset, or non-TTY). Shared
 * by the guided connect flow and the picker's auth-first check.
 */
async function sdmBrowserLogin(onLine: (l: string) => void): Promise<{ ok: boolean; error?: string }> {
  const { runBrowserLogin } = await import("../lib/sdm/browser-login.ts");
  const r = await runBrowserLogin({ onLine });
  if (r.outcome === "authenticated") return { ok: true };
  if (r.outcome === "needs-manual") {
    if (!process.stdin.isTTY) {
      return { ok: false, error: `${r.reason} Run \`rt sdm login --manual\` in a terminal first.` };
    }
    return loginSdm(onLine); // no Chrome: terminal flow
  }
  return { ok: false, error: r.error };
}

/**
 * Auth-first guard for the picker. An expired StrongDM session means the
 * scan cannot list resources (you would see only recents), so log in
 * before scanning -- automatically, no confirm, per the connect UX.
 * Returns true when a login happened, so the caller can bust the stale cache.
 */
async function ensureSdmAuth(): Promise<boolean> {
  const snapshot = await getSdmSnapshot();
  if (snapshot.health.status !== "not-authenticated") return false;
  console.error(`${yellow}StrongDM session expired${reset} ${dim}logging in…${reset}`);
  const r = await sdmBrowserLogin(streamLine);
  if (r.ok) {
    console.error(`${green}✓ logged in${reset}`);
    return true;
  }
  console.error(`${red}✗ login failed:${reset} ${r.error ?? "unknown"} ${dim}(showing recents; try \`rt sdm login --manual\`)${reset}`);
  return false;
}

async function guidedConnect(target: GuidedTarget, opts: { duration?: string; reason?: string; interactive: boolean }): Promise<void> {
  const { select, textInput, confirm } = await import("../lib/rt-render.tsx");
  const result = await runGuidedConnect(target, opts, {
    getSnapshot: f => getSdmSnapshot(f),
    needsAccessRequest: async resource => {
      const catalog = await fetchAccessCatalog();
      return catalog.ok ? resourceNeedsAccessRequest(catalog.output, resource) : false;
    },
    requestAccess,
    connect: connectResource,
    verify: url => verifyWithRetries(() => probeQuery(url, VERIFY_ATTEMPT_TIMEOUT_MS)),
    login: sdmBrowserLogin,
    promptDuration: async def => {
      const all = [
        { value: "8h", label: "8 hours" },
        { value: "4h", label: "4 hours" },
        { value: "1h", label: "1 hour" },
      ];
      // select() has no initialValue option; ordering puts the default first.
      const options = [...all.filter(o => o.value === def), ...all.filter(o => o.value !== def)];
      return select({ message: "Access duration", options });
    },
    promptReason: async def => textInput({ message: "Reason (org-visible)", defaultValue: def }),
    confirmProduction: async t => {
      console.error(`${red}${bold}PRODUCTION${reset} ${t.label}`);
      const input = await textInput({ message: `Type "${t.label}" to confirm` });
      return input.trim() === t.label;
    },
    confirmLogin: async () => confirm({ message: "StrongDM is not authenticated. Run sdm login now?", initialValue: true }),
    onLine: streamLine,
    recordRecent: t =>
      void recordRecent({
        key: t.key, label: t.label, sdmResource: t.sdmResource,
        tier: t.tier, production: t.production, reasonSuggestion: t.reasonSuggestion, db: t.db,
      }),
  });

  if (result.outcome === "connected") {
    const dbInfo = target.db ? ` ${dim}(${target.db.database ?? "postgres"}/${target.db.schema ?? "public"})${reset}` : "";
    console.log(`\n${green}✓${reset} ${bold}${target.label}${reset} ready at ${cyan}${result.address}${reset}${dbInfo}`);
    console.log(`  ${dim}verified in ${result.verify.latencyMs}ms (${result.verify.attempts} attempt${result.verify.attempts === 1 ? "" : "s"})${reset}`);
    return;
  }
  if (result.outcome === "aborted") {
    console.log(`${yellow}aborted:${reset} ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  console.error(`${red}✗ ${result.stage} failed:${reset} ${result.error}`);
  if (result.hint) console.error(`  ${dim}${result.hint}${reset}`);
  process.exitCode = 1;
}

function toTarget(c: SdmConnection | RecentEntry): GuidedTarget {
  return {
    key: c.key, label: c.label, sdmResource: c.sdmResource,
    tier: c.tier, production: c.production,
    reasonSuggestion: c.reasonSuggestion, db: c.db,
  };
}

// ── Subcommands ──────────────────────────────────────────────────────────────

async function pickAndConnect(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error("rt sdm connect needs a terminal. Use `rt sdm connect <key> --duration --reason` for scripts.");
    process.exitCode = 1;
    return;
  }
  // Auth-first: an expired session lists nothing (only recents), so log in
  // before scanning. Refresh the scan when we just logged in, since a stale
  // cache from the logged-out run would still be empty.
  const loggedIn = await ensureSdmAuth();
  const { withInlineSpinner } = await import("../lib/tui/inline-spinner.ts");
  const { resources, error } = await withInlineSpinner("scanning StrongDM…", () => getScan(loggedIn));
  const recents = loadSdmState().recents;

  if (error) console.error(`${yellow}${error}${reset}`);
  if (resources.length === 0 && recents.length === 0) {
    console.log(`${bold}No StrongDM resources found.${reset}

rt scans your StrongDM catalog + status directly; there's nothing to configure.
Make sure you're logged in and have access to at least one postgres resource.

Nicer labels/tiers:    ${bold}rt sdm enrichment init${reset}
StrongDM CLI install:  ${dim}${SDM_INSTALL_URL}${reset}`);
    return;
  }

  const connections = buildSdmConnections(resources, loadEnrichment());
  const { runNavPicker } = await import("../lib/navigate.ts");
  const options = buildPickerOptions(connections, recents);
  const picked = await runNavPicker({ options, message: "sdm connections" });
  if (!picked || !picked.value) return;

  const target =
    connections.find(c => c.key === picked.value) ??
    recents.find(r => r.key === picked.value);
  if (!target) {
    console.error(`${red}unknown selection:${reset} ${picked.value}`);
    process.exitCode = 1;
    return;
  }
  await guidedConnect(toTarget(target), { interactive: true });
}

/**
 * `rt sdm connect` with no key opens the connection picker; `rt sdm connect
 * <key> [--duration 8h] [--reason "..."]` connects directly (scriptable).
 */
export async function connectCmd(rest: string[], _ctx?: CommandContext): Promise<void> {
  const flags: { duration?: string; reason?: string } = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--duration") flags.duration = rest[++i];
    else if (arg === "--reason") flags.reason = rest[++i];
    else if (arg.startsWith("--duration=")) flags.duration = arg.slice("--duration=".length);
    else if (arg.startsWith("--reason=")) flags.reason = arg.slice("--reason=".length);
    else positional.push(arg);
  }
  const key = positional[0];
  if (!key) return pickAndConnect();
  const { resources } = await getScan();
  const connections = buildSdmConnections(resources, loadEnrichment());
  const target =
    connections.find(c => c.key === key) ??
    loadSdmState().recents.find(r => r.key === key);
  if (!target) {
    console.error(`${red}unknown connection key:${reset} ${key} ${dim}(rt sdm refresh to re-discover)${reset}`);
    process.exitCode = 1;
    return;
  }
  const interactive = process.stdin.isTTY && !(flags.duration && flags.reason);
  await guidedConnect(toTarget(target), { ...flags, interactive });
}

export async function statusCmd(): Promise<void> {
  const snapshot = await getSdmSnapshot(true);
  if (snapshot.health.status !== "ok") {
    console.log(`${red}sdm:${reset} ${snapshot.health.status} ${dim}${snapshot.health.message ?? ""}${reset}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${green}sdm: authenticated${reset}`);
  const connected = [...snapshot.resources.entries()].filter(([, s]) => s.connected);
  if (connected.length === 0) {
    console.log(`${dim}no tunnels connected${reset}`);
    return;
  }
  for (const [name, s] of connected) {
    const expiry = s.expiry ? ` ${dim}until ${s.expiry}${reset}` : "";
    console.log(`  ${green}●${reset} ${name} ${cyan}${s.address ?? ""}${reset}${expiry}`);
  }
}

async function runManualLogin(): Promise<void> {
  const r = await loginSdm(streamLine);
  if (r.ok) console.log(`${green}✓ logged in${reset}`);
  else { console.error(`${red}✗ ${r.error}${reset}`); process.exitCode = 1; }
}

export async function loginCmd(args: string[]): Promise<void> {
  const manual = args.includes("--manual");
  const visible = args.includes("--visible");

  if (manual) {
    if (!process.stdin.isTTY) {
      console.error("sdm login --manual is interactive; run it from a terminal.");
      process.exitCode = 1;
      return;
    }
    console.log(`${dim}running sdm login (answer its prompts here; your browser will open for SAML)...${reset}`);
    await runManualLogin();
    return;
  }

  console.log(`${dim}logging in to StrongDM${visible ? " (window will show)" : " (silent)"}...${reset}`);
  const { runBrowserLogin } = await import("../lib/sdm/browser-login.ts");
  const outcome = await runBrowserLogin({ visible, onLine: streamLine });
  if (outcome.outcome === "authenticated") {
    console.log(`${green}✓ logged in${reset}`);
    return;
  }
  if (outcome.outcome === "needs-manual") {
    if (!process.stdin.isTTY) {
      // No "Falling back..." here: with no TTY the fallback cannot actually
      // run (runManualLogin needs a terminal), so saying it would be
      // contradicted immediately by the guidance on the next line.
      console.error(`${yellow}${outcome.reason}${reset}`);
      console.error("Run `rt sdm login --manual` in a terminal.");
      process.exitCode = 1;
      return;
    }
    console.log(`${yellow}${outcome.reason} Falling back to terminal login.${reset}`);
    await runManualLogin();
    return;
  }
  console.error(`${red}✗ login failed:${reset} ${outcome.error}`);
  console.error(`  ${dim}try \`rt sdm login --visible\` to watch, or \`--manual\` for the terminal flow${reset}`);
  process.exitCode = 1;
}

export async function refreshCmd(): Promise<void> {
  const { resources, error } = await getScan(true);
  if (error) console.log(`  ${red}✗${reset} ${dim}${error}${reset}`);
  console.log(`${bold}${resources.length} resource${resources.length === 1 ? "" : "s"}${reset} from StrongDM`);
  if (resources.length === 0 && !error) {
    console.log(`${dim}no postgres resources visible; check StrongDM access${reset}`);
  }
}

/**
 * Pure formatter for `rt sdm enrichment init`: a JSONC skeleton with one
 * entry per scanned resource name, ready to fill in labels/tiers. No console
 * writes, so this is unit-testable without a terminal.
 */
export function enrichmentSkeleton(names: string[]): string {
  const lines = [
    "{",
    "  // rt sdm enrichment: map a StrongDM resource name to a nicer label/tier/db.",
    "  // Fill in labels; delete resources you do not care about. Unmapped -> raw name.",
  ];
  names.forEach((name, i) => lines.push(`  ${JSON.stringify(name)}: { "label": "", "tier": "" }${i === names.length - 1 ? "" : ","}`));
  lines.push("}", "");
  return lines.join("\n");
}

/**
 * `rt sdm enrichment`: show how much of the scanned catalog is enriched.
 * `rt sdm enrichment init`: scaffold ~/.rt/sdm/enrichment.jsonc with one
 * entry per scanned resource, refusing to clobber an existing file.
 */
export async function enrichmentCmd(rest: string[]): Promise<void> {
  const { enrichmentPath, loadEnrichment } = await import("../lib/sdm/enrichment.ts");
  const path = enrichmentPath();
  if (rest[0] === "init") {
    if (existsSync(path)) {
      console.error(`${yellow}${path} already exists${reset}`);
      process.exitCode = 1;
      return;
    }
    const { resources } = await getScan(true);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, enrichmentSkeleton(resources.map(r => r.name)));
    console.log(`${green}✓${reset} wrote ${cyan}${path}${reset} ${dim}(${resources.length} resources; fill in labels)${reset}`);
    return;
  }
  const enr = loadEnrichment(path);
  const { resources } = await getScan();
  const enriched = resources.filter(r => enr[r.name]).length;
  console.log(`${bold}enrichment:${reset} ${cyan}${path}${reset}`);
  console.log(`  ${enriched}/${resources.length} resources enriched ${dim}(the rest show raw names)${reset}`);
}
