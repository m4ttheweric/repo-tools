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
import { flagValues } from "../lib/cli-args.ts";
import { currentMode } from "../lib/dev-mode.ts";
import { envelope } from "../lib/setup/contract.ts";
import { UserActionableError, exitUserError } from "../lib/setup/errors.ts";
import { servicePlists } from "../lib/setup/need.ts";
import { createRealProbes, type Probes } from "../lib/setup/probes.ts";

export interface ServicesDeps {
  probes: Probes;
  print: (s: string) => void;
  /** Diagnostics that must never land on stdout (would corrupt --json output) — real default is console.error. */
  warn: (s: string) => void;
  /** Unused by exitUserError, which always calls the real process.exit (repo-wide convention, see commands/team.ts) — this seam only covers the ok:false paths this module controls directly. */
  exit?: (code: number) => never;
}

export function realServicesDeps(): ServicesDeps {
  return { probes: createRealProbes(), print: (s) => console.log(s), warn: (s) => console.error(s), exit: process.exit };
}

interface ServiceAgent {
  label: string;
  status: string;
}

interface RegisterReply {
  ok: boolean;
  results?: unknown;
}

function appNotRunning(json: boolean, verb: string, deps: ServicesDeps): never {
  exitUserError(new UserActionableError("app-not-running", "mattstack.app is not running — open it, then retry"), json, verb, deps.print);
}

function exitWith(deps: ServicesDeps, code: number): never {
  return (deps.exit ?? process.exit)(code);
}

export async function servicesList(args: string[], _ctx: CommandContext = {}, deps: ServicesDeps = realServicesDeps()): Promise<void> {
  const json = args.includes("--json");

  const res = await deps.probes.tray<{ agents: ServiceAgent[] }>("/services", { method: "GET" });
  if (res.status === 0) appNotRunning(json, "services list", deps);

  const agents = res.status === 200 ? res.json?.agents : undefined;
  if (!Array.isArray(agents)) {
    exitUserError(
      new UserActionableError("services-list-failed", `mattstack.app returned an unexpected /services response (status ${res.status})`),
      json,
      "services list",
      deps.print,
    );
  }

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
  let plists: string[];
  if (explicit.length > 0) {
    plists = explicit;
  } else {
    const defaults = servicePlists(currentMode(), deps.probes);
    plists = defaults.plists;
    if (defaults.deckOmitted) deps.warn("deck not bundled yet — only the daemon is registered");
  }

  const res = await deps.probes.tray<RegisterReply>("/services/register", { method: "POST", body: { plists } });
  if (res.status === 0) appNotRunning(json, "services register", deps);

  const ok = res.json?.ok ?? false;
  if (json) {
    deps.print(JSON.stringify(envelope({ ok, plists, results: res.json?.results })));
    if (!ok) exitWith(deps, 1);
    return;
  }
  deps.print(`rt services register: ${ok ? "ok" : "failed"} (${plists.join(", ")})`);
  if (!ok) exitWith(deps, 1);
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
    if (!ok) exitWith(deps, 1);
    return;
  }
  deps.print(`rt services restart: ${label} — ${ok ? "ok" : "failed"}`);
  if (!ok) exitWith(deps, 1);
}
