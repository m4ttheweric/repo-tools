/**
 * `plugins.install` — adds the mattstack marketplace (plus whatever the user
 * or team already configured) and installs the baseline plugin set through
 * the `claude` CLI itself, once per Claude config dir. This is also the ONE
 * place a fresh machine's skills end up materialized: skills.materialize
 * runs earlier in the contract order and skips honestly when the mattstack
 * plugin isn't on disk yet, so this step re-runs the same materialize
 * function after installing that plugin — never a second implementation
 * of it.
 *
 * The installer only ever adds marketplaces/plugins here — it never touches
 * ~/.claude/settings.json, hooks, or ~/.claude.json.
 */

import { join } from "path";
import { resolveTool } from "../../deps/resolve.ts";
import { getSetting } from "../../settings/resolve.ts";
import { stripJsonc } from "../../skills/sources.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";
import { materializeSkills } from "../skills-materialize.ts";
import type { Probes } from "../probes.ts";
import { updateSetupState } from "../state.ts";
import { claudeConfigDirs } from "../tools-install.ts";
import { toFailedOutcome } from "./step-utils.ts";

export const MATTSTACK_MARKETPLACE_SOURCE = "https://github.com/m4ttstack/mattstack-marketplace";
const BASE_PLUGINS = ["mattstack@mattstack", "fast-browser@mattstack"];
const PLUGIN_EXEC_TIMEOUT_MS = 60_000;
const RETRY_REMEDY = "Open Claude Code once so it finishes first-run, then Retry.";

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function combinedOutput(res: { stdout: string; stderr: string }): string {
  return `${res.stdout}\n${res.stderr}`;
}

function isAlready(res: { stdout: string; stderr: string }): boolean {
  return /already/i.test(combinedOutput(res));
}

function isUnknownSubcommand(res: { stdout: string; stderr: string }): boolean {
  return /unknown (sub)?command/i.test(combinedOutput(res));
}

interface TeamMarketplaceFile {
  name?: string;
  plugins?: { name?: string }[];
}

function teamMarketplacePath(home: string, slug: string): string {
  return join(home, ".mattstack", "teams", slug, ".claude-plugin", "marketplace.json");
}

/** Absent or unparsable both read as "no team marketplace" — a fresh clone or a marketplace.json this repo doesn't own yet is never a step failure. */
function readTeamMarketplace(p: Pick<Probes, "readFile" | "home">, slug: string): TeamMarketplaceFile | null {
  const raw = p.readFile(teamMarketplacePath(p.home, slug));
  if (raw === null) return null;
  try {
    return JSON.parse(stripJsonc(raw)) as TeamMarketplaceFile;
  } catch {
    return null;
  }
}

function teamMarketplaceDir(p: Pick<Probes, "home">, slug: string): string {
  return join(p.home, ".mattstack", "teams", slug);
}

function computeMarketplaces(ctx: ApplyContext): string[] {
  const userSet = getSetting<string[]>("claude.marketplaces").value ?? [];
  const mattstackSource = ctx.p.env.RT_MATTSTACK_MARKETPLACE || MATTSTACK_MARKETPLACE_SOURCE;
  const teamSource = ctx.team.slug ? [teamMarketplaceDir(ctx.p, ctx.team.slug)] : [];
  return dedupe([...userSet, mattstackSource, ...teamSource]);
}

function computePlugins(ctx: ApplyContext, teamMarketplace: TeamMarketplaceFile | null): string[] {
  const userSet = getSetting<string[]>("claude.plugins").value ?? [];
  const marketplaceName = teamMarketplace?.name ?? ctx.team.slug;
  const teamPlugins = (teamMarketplace?.plugins ?? [])
    .map((plugin) => plugin.name)
    .filter((name): name is string => Boolean(name))
    .map((name) => `${name}@${marketplaceName}`);
  return dedupe([...userSet, ...BASE_PLUGINS, ...teamPlugins]);
}

async function runMaterializeAfterInstall(ctx: ApplyContext): Promise<string> {
  const result = await materializeSkills(ctx.p, {});
  if (result.skipped) {
    ctx.log("plugins.install", `materialize: ${result.reason}`);
    return `materialize skipped: ${result.reason}`;
  }
  const failed = result.repos.filter((r) => !r.ok);
  for (const r of failed) ctx.log("plugins.install", `materialize ${r.name}: ${r.detail}`);
  const ok = result.repos.length - failed.length;
  return `materialized ${ok}, failed ${failed.length}`;
}

async function pluginsInstallRun(ctx: ApplyContext): Promise<StepOutcome> {
  const claude = resolveTool(ctx.p, "claude");
  if (!claude.exec) {
    return { state: "failed", detail: "claude not found (not bundled, no user copy on PATH)", remedy: "Install Claude Code (Tools row), then Retry." };
  }

  const teamMarketplace = ctx.team.slug ? readTeamMarketplace(ctx.p, ctx.team.slug) : null;
  const marketplaces = computeMarketplaces(ctx);
  const plugins = computePlugins(ctx, teamMarketplace);
  const configDirs = claudeConfigDirs(ctx.p, []);

  for (const dir of configDirs) {
    const env = { CLAUDE_CONFIG_DIR: dir };

    for (const src of marketplaces) {
      const res = await ctx.p.exec([...claude.exec, "plugin", "marketplace", "add", src], { env, timeoutMs: PLUGIN_EXEC_TIMEOUT_MS });
      if (res.code !== 0 && !isAlready(res)) {
        return { state: "failed", detail: `claude plugin marketplace add exited ${res.code}`, remedy: RETRY_REMEDY };
      }
    }

    for (const plugin of plugins) {
      const install = await ctx.p.exec([...claude.exec, "plugin", "install", plugin], { env, timeoutMs: PLUGIN_EXEC_TIMEOUT_MS });
      if (install.code !== 0 && !isAlready(install)) {
        return { state: "failed", detail: `claude plugin install exited ${install.code}`, remedy: RETRY_REMEDY };
      }

      // `enable` is best-effort: an older claude build without the
      // subcommand must never fail an otherwise-successful install.
      const enable = await ctx.p.exec([...claude.exec, "plugin", "enable", plugin], { env, timeoutMs: PLUGIN_EXEC_TIMEOUT_MS });
      if (enable.code !== 0 && !isAlready(enable) && !isUnknownSubcommand(enable)) {
        ctx.log("plugins.install", `claude plugin enable ${plugin} (${dir}) exited ${enable.code} — ignored`);
      }
    }
  }

  updateSetupState(ctx.p, (s) => ({ ...s, marketplaces: [...s.marketplaces, ...marketplaces], plugins: [...s.plugins, ...plugins] }));

  const materializeDetail = await runMaterializeAfterInstall(ctx);
  return { state: "done", detail: `${marketplaces.length} marketplace(s), ${plugins.length} plugin(s) across ${configDirs.length} config dir(s) · ${materializeDetail}` };
}

async function pluginsInstallRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await pluginsInstallRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const pluginsInstallStep: StepDef = {
  id: "plugins.install",
  title: "Install plugins",
  kind: "rt",
  applies: () => true,
  run: pluginsInstallRunSafe,
};
