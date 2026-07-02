/**
 * rt sdm: StrongDM connections. `sdm` is a branch node (cli.ts); subcommands:
 *
 *   rt sdm connect [<key>] [--duration 8h] [--reason "..."]  picker, or connect a key
 *   rt sdm status                   CLI health + connected tunnels
 *   rt sdm login [--manual] [--visible]   log in (default: browser popup flow)
 *   rt sdm refresh                  re-run connectors, bust the cache
 *   rt sdm connectors [test|init <name>]  list/validate/scaffold connectors
 *
 * The daemon serves the connector catalog when running (10-minute cache);
 * everything falls back to in-process execution when it is not.
 */

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
import {
  connectorsDir,
  discoverConnections,
  listConnectorFiles,
  runConnector,
  scaffoldConnector,
  type CatalogResult,
  type DiscoveredConnection,
} from "../lib/sdm/connectors.ts";
import { loadSdmState, recordRecent, type RecentEntry } from "../lib/sdm/state.ts";
import { runGuidedConnect, type GuidedTarget } from "../lib/sdm/flow.ts";
import { probeQuery, verifyWithRetries, VERIFY_ATTEMPT_TIMEOUT_MS } from "../lib/sdm/verify.ts";
import { buildPickerOptions } from "../lib/sdm/picker.ts";

// `sdm` is a branch node in the command tree (cli.ts); each subcommand below
// is a leaf pointing at one of these exported functions.

// ── Catalog access (daemon-first, in-process fallback) ──────────────────────

async function getCatalog(refresh = false): Promise<CatalogResult> {
  const { daemonQuery } = await import("../lib/daemon-client.ts");
  const result = await daemonQuery("sdm:catalog", refresh ? { refresh: true } : undefined, 45_000);
  if (result?.ok && Array.isArray((result as any).connections)) {
    const r = result as any;
    const connections = r.connections as DiscoveredConnection[];
    const errors = r.errors ?? [];
    // A daemon stuck on a bad PATH (e.g. launchd with no bun) can report ok
    // with zero connections and every connector erroring. Trusting that
    // would mask a working in-process discovery, so fall back instead.
    if (connections.length === 0 && errors.length > 0) {
      return discoverConnections({ refresh });
    }
    return { connections, errors, fromCache: r.fromCache ?? false };
  }
  return discoverConnections({ refresh });
}

// ── Guided flow wiring (real prompts, real sdm) ──────────────────────────────

function streamLine(line: string): void {
  process.stderr.write(`  ${dim}${line}${reset}\n`);
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
    login: async (onLine) => {
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
    },
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

function toTarget(c: DiscoveredConnection | RecentEntry): GuidedTarget {
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
  const { withInlineSpinner } = await import("../lib/tui/inline-spinner.ts");
  const catalog = await withInlineSpinner("discovering connections…", () => getCatalog());
  const recents = loadSdmState().recents;

  for (const e of catalog.errors) {
    console.error(`${yellow}connector ${e.connector} failed:${reset} ${dim}${e.error}${reset}`);
  }
  if (catalog.connections.length === 0 && recents.length === 0) {
    console.log(`${bold}No sdm connections discovered.${reset}

Connectors are executables in ${cyan}${connectorsDir()}${reset} that print
connections as JSON when run with the argument ${bold}discover${reset}.

Start with a template:  ${bold}rt sdm connectors init my-org${reset}
Validate it:            ${bold}rt sdm connectors test my-org${reset}
StrongDM CLI install:   ${dim}${SDM_INSTALL_URL}${reset}`);
    return;
  }

  const { runNavPicker } = await import("../lib/navigate.ts");
  const options = buildPickerOptions(catalog.connections, recents);
  const picked = await runNavPicker({ options, message: "sdm connections" });
  if (!picked || !picked.value) return;

  const target =
    catalog.connections.find(c => c.key === picked.value) ??
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
  const catalog = await getCatalog();
  const target =
    catalog.connections.find(c => c.key === key) ??
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
  const catalog = await getCatalog(true);
  const byConnector = new Map<string, number>();
  for (const c of catalog.connections) {
    byConnector.set(c.connector, (byConnector.get(c.connector) ?? 0) + 1);
  }
  for (const [name, count] of byConnector) {
    console.log(`  ${green}●${reset} ${name}: ${count} connection${count === 1 ? "" : "s"}`);
  }
  for (const e of catalog.errors) {
    console.log(`  ${red}✗${reset} ${e.connector}: ${dim}${e.error}${reset}`);
  }
  const total = catalog.connections.length;
  console.log(`${bold}${total} connection${total === 1 ? "" : "s"}${reset} from ${byConnector.size} connector${byConnector.size === 1 ? "" : "s"}`);
  if (total === 0 && catalog.errors.length === 0) {
    console.log(`${dim}no connectors installed; run: rt sdm connectors init <name>${reset}`);
  }
}

export async function connectorsCmd(rest: string[]): Promise<void> {
  const [action, name] = rest;

  if (action === "init") {
    if (!name) {
      console.error("usage: rt sdm connectors init <name>");
      process.exitCode = 1;
      return;
    }
    try {
      const path = scaffoldConnector(name);
      console.log(`${green}✓${reset} created ${cyan}${path}${reset}`);
      console.log(`  edit it, then validate with: ${bold}rt sdm connectors test ${name}${reset}`);
    } catch (e) {
      console.error(`${red}✗ ${(e as Error).message}${reset}`);
      process.exitCode = 1;
    }
    return;
  }

  if (action === "test") {
    if (!name) {
      console.error("usage: rt sdm connectors test <name>");
      process.exitCode = 1;
      return;
    }
    const file = listConnectorFiles().find(f => f.split("/").pop()!.replace(/\.[^.]+$/, "") === name);
    if (!file) {
      console.error(`${red}✗ no connector named ${name} in ${connectorsDir()}${reset}`);
      process.exitCode = 1;
      return;
    }
    const r = await runConnector(file);
    if (!r.ok) {
      console.error(`${red}✗ ${r.error}${reset}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${green}✓ valid${reset} (${r.output.connections.length} connections)`);
    for (const c of r.output.connections) {
      console.log(`  ${c.id}  ${dim}${c.sdmResource}  ${c.tier ?? ""}${reset}`);
    }
    return;
  }

  if (action !== undefined) {
    console.error("usage: rt sdm connectors [test <name> | init <name>]");
    process.exitCode = 1;
    return;
  }

  const files = listConnectorFiles();
  if (files.length === 0) {
    console.log(`${dim}no connectors in ${connectorsDir()}${reset}`);
    console.log(`scaffold one: ${bold}rt sdm connectors init <name>${reset}`);
    return;
  }
  const catalog = await getCatalog();
  for (const file of files) {
    const cname = file.split("/").pop()!.replace(/\.[^.]+$/, "");
    const err = catalog.errors.find(e => e.connector === cname);
    const count = catalog.connections.filter(c => c.connector === cname).length;
    if (err) console.log(`  ${red}✗${reset} ${cname} ${dim}${err.error}${reset}`);
    else console.log(`  ${green}●${reset} ${cname} ${dim}${count} connection${count === 1 ? "" : "s"}${reset}`);
  }
}
