/**
 * rt proxy — Pause/resume daemon-managed reverse proxies.
 *
 * Subcommands:
 *   rt proxy list              print table of all proxies
 *   rt proxy pause [port]      pause (picker if no port)
 *   rt proxy pause --all       pause every live proxy
 *   rt proxy resume [port]     resume (picker over paused proxies if no port)
 *   rt proxy resume --all      resume every paused proxy
 *
 * Proxies are identified by canonical port — that's the number bound on
 * the host and the identifier users actually see. The daemon-internal proxy
 * id (e.g. "lane-a") is an implementation detail.
 */

import { bold, dim, green, yellow, red, reset } from "../lib/tui.ts";
import { daemonQuery } from "../lib/daemon-client.ts";

interface ProxyInfo {
  id: string;
  canonicalPort: number;
  upstreamPort: number;
  running: boolean;
  paused: boolean;
  initiator: string;
}

async function fetchProxies(): Promise<ProxyInfo[]> {
  const res = await daemonQuery("proxy:list");
  if (!res?.ok) {
    console.log(`\n  ${red}✗ daemon not reachable${reset}\n`);
    process.exit(1);
  }
  return (res.data as ProxyInfo[]) ?? [];
}

function proxyByPort(proxies: ProxyInfo[], port: number): ProxyInfo | undefined {
  return proxies.find((p) => p.canonicalPort === port);
}

function initiatorLabel(p: ProxyInfo): string {
  return p.initiator || "unknown";
}

function displayProxies(proxies: ProxyInfo[]): void {
  if (proxies.length === 0) {
    console.log(`\n  ${dim}no proxies registered${reset}\n`);
    return;
  }
  console.log("");
  for (const p of proxies) {
    const state = p.paused ? `${yellow}paused${reset}` : `${green}running${reset}`;
    const portStr = `:${p.canonicalPort}`.padEnd(7);
    const upstreamStr = `→ :${p.upstreamPort}`.padEnd(10);
    console.log(`  ${bold}${portStr}${reset} ${state.padEnd(18)} ${upstreamStr} ${dim}${initiatorLabel(p)} · ${p.id}${reset}`);
  }
  console.log("");
}

async function pauseOne(p: ProxyInfo): Promise<void> {
  if (p.paused) {
    console.log(`  ${dim}:${p.canonicalPort} already paused${reset}`);
    return;
  }
  const res = await daemonQuery("proxy:pause", { id: p.id });
  if (res?.ok) console.log(`  ${yellow}paused${reset}   :${p.canonicalPort} ${dim}(${p.id})${reset}`);
  else console.log(`  ${red}failed${reset}   :${p.canonicalPort} ${dim}${res?.error ?? ""}${reset}`);
}

async function resumeOne(p: ProxyInfo): Promise<void> {
  if (!p.paused) {
    console.log(`  ${dim}:${p.canonicalPort} already running${reset}`);
    return;
  }
  const res = await daemonQuery("proxy:resume", { id: p.id });
  if (res?.ok) console.log(`  ${green}resumed${reset}  :${p.canonicalPort} ${dim}(${p.id})${reset}`);
  else console.log(`  ${red}failed${reset}   :${p.canonicalPort} ${dim}${res?.error ?? ""}${reset}`);
}

async function pickAndAct(
  proxies: ProxyInfo[],
  verb: "pause" | "resume",
  act: (p: ProxyInfo) => Promise<void>,
): Promise<void> {
  if (proxies.length === 0) {
    console.log(`\n  ${dim}nothing to ${verb}${reset}\n`);
    return;
  }
  const { filterableMultiselect } = await import("../lib/rt-render.tsx");
  const picked = await filterableMultiselect({
    message: `Select proxies to ${verb} (or esc to exit)`,
    options: proxies.map((p) => {
      const tail = p.paused ? `${dim}(paused)${reset}` : `${green}→ :${p.upstreamPort}${reset}`;
      return {
        value: p.id,
        label: `${yellow}:${p.canonicalPort}${reset}  ${tail}  ${dim}${initiatorLabel(p)}${reset}`,
      };
    }),
  });
  if (!picked || picked.length === 0) {
    console.log(`\n  ${dim}nothing selected${reset}\n`);
    return;
  }
  console.log("");
  for (const id of picked) {
    const p = proxies.find((x) => x.id === id);
    if (p) await act(p);
  }
  console.log("");
}

function parsePort(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  return parseInt(raw, 10);
}

async function runPauseOrResume(
  verb: "pause" | "resume",
  args: string[],
): Promise<void> {
  const all = args.includes("--all");
  const port = parsePort(args.find((a) => a !== "--all"));
  const proxies = await fetchProxies();
  const act = verb === "pause" ? pauseOne : resumeOne;
  const pool = verb === "pause"
    ? proxies.filter((p) => !p.paused)
    : proxies.filter((p) => p.paused);

  if (all) {
    if (pool.length === 0) {
      console.log(`\n  ${dim}nothing to ${verb}${reset}\n`);
      return;
    }
    console.log("");
    for (const p of pool) await act(p);
    console.log("");
    return;
  }

  if (port !== null) {
    const p = proxyByPort(proxies, port);
    if (!p) {
      console.log(`\n  ${dim}no proxy on :${port}${reset}\n`);
      return;
    }
    console.log("");
    await act(p);
    console.log("");
    return;
  }

  if (!process.stdin.isTTY) {
    displayProxies(proxies);
    return;
  }
  await pickAndAct(pool, verb, act);
}

// ─── Subcommand handlers ─────────────────────────────────────────────────────

export async function listCommand(): Promise<void> {
  displayProxies(await fetchProxies());
}

export async function pauseCommand(args: string[]): Promise<void> {
  await runPauseOrResume("pause", args);
}

export async function resumeCommand(args: string[]): Promise<void> {
  await runPauseOrResume("resume", args);
}
