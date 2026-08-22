/**
 * rt services list|register|restart — thin facade over tray.sock's
 * /services routes (mattstack.app's LaunchAgent registrar). Used standalone
 * and by the apply engine's services.register step.
 *
 *   rt services list [--json]
 *   rt services register [--plist <name>]… [--json]
 *   rt services restart <label> [--json]
 */

import type { CommandContext } from "../lib/command-tree.ts";
import { bundledToolPath } from "../lib/deps/resolve.ts";
import { currentMode } from "../lib/dev-mode.ts";
import { envelope } from "../lib/setup/contract.ts";
import { UserActionableError, exitUserError } from "../lib/setup/errors.ts";
import { servicePlists } from "../lib/setup/need.ts";
import { createRealProbes, type Probes } from "../lib/setup/probes.ts";

export interface ServicesDeps {
  probes: Probes;
  print: (s: string) => void;
}

export function realServicesDeps(): ServicesDeps {
  return { probes: createRealProbes(), print: (s) => console.log(s) };
}

interface ServiceAgent {
  label: string;
  status: string;
}

interface RegisterReply {
  ok: boolean;
  results?: unknown;
}

function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] !== undefined) values.push(args[i + 1]!);
  }
  return values;
}

function appNotRunning(json: boolean, verb: string, deps: ServicesDeps): never {
  exitUserError(new UserActionableError("app-not-running", "mattstack.app is not running — open it, then retry"), json, verb, deps.print);
}

export async function servicesList(args: string[], _ctx: CommandContext = {}, deps: ServicesDeps = realServicesDeps()): Promise<void> {
  const json = args.includes("--json");

  const res = await deps.probes.tray<{ agents: ServiceAgent[] }>("/services", { method: "GET" });
  if (res.status === 0) appNotRunning(json, "services list", deps);

  const agents = res.json?.agents ?? [];
  if (json) {
    deps.print(JSON.stringify(envelope({ agents })));
    return;
  }
  if (agents.length === 0) {
    deps.print("rt services list: no registered agents");
    return;
  }
  for (const agent of agents) deps.print(`${agent.label}: ${agent.status}`);
}

export async function servicesRegister(args: string[], _ctx: CommandContext = {}, deps: ServicesDeps = realServicesDeps()): Promise<void> {
  const json = args.includes("--json");
  const explicit = flagValues(args, "--plist");
  const plists = explicit.length > 0 ? explicit : servicePlists(currentMode(), deps.probes);

  if (explicit.length === 0 && bundledToolPath(deps.probes, "deck") === null) {
    console.error("deck not bundled yet — only the daemon is registered");
  }

  const res = await deps.probes.tray<RegisterReply>("/services/register", { method: "POST", body: { plists } });
  if (res.status === 0) appNotRunning(json, "services register", deps);

  const ok = res.json?.ok ?? false;
  if (json) {
    deps.print(JSON.stringify(envelope({ ok, plists, results: res.json?.results })));
    if (!ok) process.exit(1);
    return;
  }
  deps.print(`rt services register: ${ok ? "ok" : "failed"} (${plists.join(", ")})`);
  if (!ok) process.exit(1);
}

export async function servicesRestart(args: string[], _ctx: CommandContext = {}, deps: ServicesDeps = realServicesDeps()): Promise<void> {
  const json = args.includes("--json");
  const label = args.find((a) => !a.startsWith("--"));
  if (!label) exitUserError(new UserActionableError("usage", "usage: rt services restart <label> [--json]"), json, "services restart", deps.print);

  const res = await deps.probes.tray<{ ok: boolean }>("/services/restart", { method: "POST", body: { label } });
  if (res.status === 0) appNotRunning(json, "services restart", deps);

  const ok = res.json?.ok ?? false;
  if (json) {
    deps.print(JSON.stringify(envelope({ ok, label })));
    if (!ok) process.exit(1);
    return;
  }
  deps.print(`rt services restart: ${label} — ${ok ? "ok" : "failed"}`);
  if (!ok) process.exit(1);
}
