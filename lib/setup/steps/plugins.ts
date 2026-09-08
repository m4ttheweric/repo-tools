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
import { stripJsonc } from "../../jsonc.ts";
import { getSetting } from "../../settings/resolve.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";
import { BASE_PLUGINS } from "../base-plugins.ts";
import { materializeSkills } from "../skills-materialize.ts";
import type { Probes } from "../probes.ts";
import { parsePluginList, settlePack, PACK_EXEC_TIMEOUT_MS, SETTLE_EXEC_TIMEOUT_MS, type ClaudeRunner } from "../pack-cache.ts";
import { updateSetupState } from "../state.ts";
import { claudeConfigDirs } from "../tools-install.ts";
import { toFailedOutcome } from "./step-utils.ts";

export const MATTSTACK_MARKETPLACE_SOURCE = "https://github.com/m4ttstack/mattstack-marketplace";
const PLUGIN_EXEC_TIMEOUT_MS = 60_000;
const RETRY_REMEDY = "Open Claude Code once so it finishes first-run, then Retry.";

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Anchored to known "already done" phrasing in stderr only — an unanchored match over stdout+stderr would let a genuinely failing call (whose output merely mentions the word "already" in passing) read as success. */
function isAlready(res: { stderr: string }): boolean {
  return /already (installed|added|exists)/i.test(res.stderr);
}

function isNotFoundResult(res: { stderr: string }): boolean {
  return /not found/i.test(res.stderr);
}

function isUnknownSubcommand(res: { stdout: string; stderr: string }): boolean {
  return /unknown (sub)?command/i.test(`${res.stdout}\n${res.stderr}`);
}

/** `claude.marketplaces`/`claude.plugins` are `user`+`team` scope, so a team's hand-written settings.team.jsonc can carry anything the registry's `type: "array"` doesn't constrain — the same guard `team-settings.ts` already applies to these two keys. A non-string element is dropped (and logged) rather than spliced into argv, where it would stringify to `[object Object]` and fail with a misleading remedy. */
function stringSettingArray(ctx: ApplyContext, key: string, value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const strings = value.filter((v): v is string => typeof v === "string");
  if (strings.length !== value.length) {
    ctx.log("plugins.install", `${key}: dropped ${value.length - strings.length} non-string entr${value.length - strings.length === 1 ? "y" : "ies"}`);
  }
  return strings;
}

interface TeamMarketplaceFile {
  name?: string;
  plugins?: { name?: string }[];
}

function teamMarketplacePath(home: string, slug: string): string {
  return join(home, ".mattstack", "teams", slug, ".claude-plugin", "marketplace.json");
}

/**
 * Absent read as "no team marketplace" — a fresh clone this repo doesn't own
 * yet is never a step failure. An unparsable file is DIFFERENT: the team
 * authored it and its plugins would otherwise vanish from a `done` step with
 * no trace, so the caller logs the parse failure by name rather than
 * treating it the same as "nothing here yet".
 */
function readTeamMarketplace(ctx: ApplyContext, slug: string): TeamMarketplaceFile | null {
  const path = teamMarketplacePath(ctx.p.home, slug);
  const raw = ctx.p.readFile(path);
  if (raw === null) return null;
  try {
    return JSON.parse(stripJsonc(raw)) as TeamMarketplaceFile;
  } catch (err) {
    ctx.log("plugins.install", `${path} did not parse as JSONC — its plugins are omitted this run (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

function teamMarketplaceDir(p: Pick<Probes, "home">, slug: string): string {
  return join(p.home, ".mattstack", "teams", slug);
}

/** A scope's resolved value is team-authored the moment `team`/`team.repo` is anywhere in its provenance — for a `merge:"replace"` key that's a single entry, present only when no stronger (user) scope overrode it. */
function isTeamAuthored(provenance: { scope: string }[]): boolean {
  return provenance.some((p) => p.scope === "team" || p.scope === "team.repo");
}

/**
 * rt's own marketplace is added FIRST, ahead of anything team- or
 * user-declared: a hostile marketplace claiming the name "mattstack" would
 * otherwise make rt's own subsequent `add` read as "already exists" (see
 * `isAlready`), silently substituting the attacker's source for every
 * BASE_PLUGINS install that follows.
 */
function computeMarketplaces(ctx: ApplyContext): string[] {
  const userSet = stringSettingArray(ctx, "claude.marketplaces", getSetting<unknown>("claude.marketplaces").value);
  const mattstackSource = ctx.p.env.RT_MATTSTACK_MARKETPLACE || MATTSTACK_MARKETPLACE_SOURCE;
  const teamSource = ctx.team.slug ? [teamMarketplaceDir(ctx.p, ctx.team.slug)] : [];
  return dedupe([mattstackSource, ...teamSource, ...userSet]);
}

interface ComputedPlugins {
  /** rt's own baseline, plus anything the USER explicitly chose (claude.plugins resolved from user/machine scope) — installed and enabled. */
  trusted: string[];
  /** Reached this list only via team-scope settings or the team's marketplace.json — installed, never auto-enabled; a joined team does not get to grant itself execution on the strength of its own settings file. */
  teamAuthored: string[];
}

function computePlugins(ctx: ApplyContext, teamMarketplace: TeamMarketplaceFile | null): ComputedPlugins {
  const resolved = getSetting<unknown>("claude.plugins");
  const settingPlugins = stringSettingArray(ctx, "claude.plugins", resolved.value);
  const settingIsTeamAuthored = isTeamAuthored(resolved.provenance);

  const marketplaceName = teamMarketplace?.name ?? ctx.team.slug;
  const teamPlugins = (teamMarketplace?.plugins ?? [])
    .map((plugin) => plugin.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .map((name) => `${name}@${marketplaceName}`);

  const trusted = dedupe([...(settingIsTeamAuthored ? [] : settingPlugins), ...BASE_PLUGINS]);
  const teamAuthored = dedupe([...(settingIsTeamAuthored ? settingPlugins : []), ...teamPlugins]).filter((p) => !trusted.includes(p));
  return { trusted, teamAuthored };
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
    // The app gates Install on tool.claude (required:true), so this branch
    // is unreachable through the shipped UI — but `rt setup apply` never
    // checks canInstall itself, and a --non-interactive/CI run with nobody
    // to act on a Retry must not dead-end the rest of the flow the way a
    // hard `failed` would (services.start, snapshot.push, verify still need
    // to run). Interactive keeps the loud failure — a human IS watching.
    const detail = "claude not found (not bundled, no user copy on PATH)";
    return ctx.nonInteractive
      ? { state: "skipped", detail }
      : { state: "failed", detail, remedy: "Install Claude Code (Tools row), then Retry." };
  }

  const teamMarketplace = ctx.team.slug ? readTeamMarketplace(ctx, ctx.team.slug) : null;
  const marketplaces = computeMarketplaces(ctx);
  const { trusted: trustedPlugins, teamAuthored: teamAuthoredPlugins } = computePlugins(ctx, teamMarketplace);
  const allPlugins = dedupe([...trustedPlugins, ...teamAuthoredPlugins]);
  const configDirs = claudeConfigDirs(ctx.p, []);

  /** The single site every trusted enable goes through. Best-effort, and logged: an older claude without the subcommand must never fail an otherwise-good install, but a silent failure would leave a disabled baseline plugin with no signal anywhere. */
  async function enableTrusted(runner: ClaudeRunner, plugin: string, dir: string): Promise<void> {
    const enable = await runner.run(["plugin", "enable", plugin], SETTLE_EXEC_TIMEOUT_MS);
    if (enable.code !== 0 && !isAlready(enable) && !isUnknownSubcommand(enable)) {
      ctx.log("plugins.install", `claude plugin enable ${plugin} (${dir}) exited ${enable.code} ... ignored`);
    }
  }

  const settled: string[] = [];

  for (const dir of configDirs) {
    const env = { CLAUDE_CONFIG_DIR: dir };

    for (const src of marketplaces) {
      const res = await ctx.p.exec([...claude.exec, "plugin", "marketplace", "add", src], { env, timeoutMs: PLUGIN_EXEC_TIMEOUT_MS });
      if (res.code !== 0 && !isAlready(res)) {
        return { state: "failed", detail: `claude plugin marketplace add exited ${res.code}`, remedy: RETRY_REMEDY };
      }
    }

    const runner: ClaudeRunner = {
      run: (args, timeoutMs) => ctx.p.exec([...claude.exec!, ...args], { env, timeoutMs }),
    };
    const listed = await runner.run(["plugin", "list", "--json"], PACK_EXEC_TIMEOUT_MS);
    const installedBefore = listed.code === 0 ? parsePluginList(listed.stdout) : null;
    // Guessing "nothing is installed" here would send every plugin down the
    // install path, and install re-enables a pack the member disabled.
    if (!installedBefore) {
      return {
        state: "failed",
        detail: "claude plugin list --json could not be read",
        remedy: "Update Claude Code, then Retry.",
      };
    }
    const byId = new Map(installedBefore.map((e) => [e.id, e]));

    for (const plugin of allPlugins) {
      const teamAuthored = teamAuthoredPlugins.includes(plugin);

      // An already-installed plugin takes update, never install: install would
      // flip a deliberately disabled pack back on.
      if (byId.has(plugin)) {
        const updated = await runner.run(["plugin", "update", plugin, "-y"], PACK_EXEC_TIMEOUT_MS);
        // A claude without `plugin update` must fall through to the settlement,
        // not fail the step with a remedy that cannot help.
        if (updated.code !== 0 && !isNotFoundResult(updated) && !isUnknownSubcommand(updated)) {
          return { state: "failed", detail: `claude plugin update exited ${updated.code}`, remedy: RETRY_REMEDY };
        }
        if (updated.code === 0) {
          // Trusted plugins keep the best-effort re-enable they get today. The
          // `tool.plugins` needs-you row's action is `rt setup pack`, which
          // lands here: without this, the one command offered for an
          // installed-but-disabled baseline plugin does nothing.
          if (!teamAuthored) await enableTrusted(runner, plugin, dir);
          settled.push(plugin);
          continue;
        }
      }

      // `settled` accumulates across config dirs, so an id can repeat; the
      // dedupe below is what makes that harmless.
      const outcome = await settlePack(runner, plugin, { teamAuthored, timeoutMs: PLUGIN_EXEC_TIMEOUT_MS });

      // Every trusted enable goes through here, both the fresh install
      // (`installed`) and the pack that turned out to be already present
      // (`current`, reachable when a plugin installed at another scope is absent
      // from this scope's listing while install still reports it installed).
      // settlePack deliberately does not enable, so this is the only site and
      // the only place the result gets logged.
      if (!teamAuthored && (outcome.kind === "installed" || outcome.kind === "current")) {
        await enableTrusted(runner, plugin, dir);
      }
      if (outcome.kind === "failed") {
        // The install-stage wording is the setup contract's detail string for a
        // failed install and must stay byte-identical.
        const detail = outcome.stage === "install" ? `claude plugin install exited ${outcome.code}` : `claude plugin ${plugin}: ${outcome.detail}`;
        return { state: "failed", detail, remedy: RETRY_REMEDY };
      }
      if (outcome.kind === "rolledBack") {
        ctx.log("plugins.install", `${plugin}: install rolled back (${outcome.detail})`);
        continue;
      }
      settled.push(plugin);
    }
  }

  updateSetupState(ctx.p, (s) => ({ ...s, marketplaces: [...s.marketplaces, ...marketplaces], plugins: [...s.plugins, ...new Set(settled)] }));

  if (teamAuthoredPlugins.length > 0) {
    ctx.log("plugins.install", `installed but NOT enabled (team-authored, needs your own \`claude plugin enable <name>\`): ${teamAuthoredPlugins.join(", ")}`);
  }

  const materializeDetail = await runMaterializeAfterInstall(ctx);
  const pendingNote = teamAuthoredPlugins.length > 0 ? ` · ${teamAuthoredPlugins.length} awaiting your approval to enable: ${teamAuthoredPlugins.join(", ")}` : "";
  return { state: "done", detail: `${marketplaces.length} marketplace(s), ${allPlugins.length} plugin(s) across ${configDirs.length} config dir(s) · ${materializeDetail}${pendingNote}` };
}

/** The plugins.install step body — also `rt setup pack`'s first phase, so it lives under one name rather than two copies of the same try/catch. */
export async function installPlugins(ctx: ApplyContext): Promise<StepOutcome> {
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
  run: installPlugins,
};
