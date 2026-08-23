/**
 * `rt uninstall` — reverses what `rt setup apply` did, action by action, over
 * the same NDJSON engine shape `rt setup apply` streams
 * (docs/superpowers/specs/2026-08-21-rt-setup-contract.md, "rt uninstall").
 *
 * This is the most destructive code in the program: every action either
 * unregisters something, deletes a link/file/directory, or hands mattstack.app
 * a privileged removal to perform. Each removal validates its target BEFORE
 * touching anything (refuse first, remove second) — a validation failure
 * reports `failed` and never partially deletes.
 */

import { existsSync, readFileSync } from "fs";
import { basename, isAbsolute, join } from "path";
import { markDaemonUninstalled } from "../daemon-config.ts";
import { currentMode } from "../dev-mode.ts";
import { DEFAULT_EXPOSED, isOurLink, unlink } from "../deps/links.ts";
import { appBundlePath, resolveTool } from "../deps/resolve.ts";
import { detectEditors, type DetectedEditor } from "../editors.ts";
import { detectShell, MARKER, removeShellIntegration, removeZshenvPrecedence, shellRcPath } from "../shell-integration.ts";
import type { ApplyContext, StepOutcome } from "./apply.ts";
import type { UninstallActionId, StepKind } from "./contract.ts";
import { needOutcome, toFailedOutcome } from "./steps/step-utils.ts";
import { deckIsHealthy, readDeckApiPort } from "./steps/deck.ts";
import { servicePlists } from "./need.ts";
import { PORTLESS_LAUNCHD_PLIST } from "./steps/services.ts";
import { claudeConfigDirs } from "./tools-install.ts";
import type { Probes } from "./probes.ts";
import { readSetupState, updateSetupState } from "./state.ts";

export interface UninstallAction {
  id: UninstallActionId;
  title: string;
  kind: StepKind;
}

/** The extension id `--uninstall-extension`/`--install-extension` take — `<publisher>.<name>` from extensions/vscode/rt-context/package.json ("local"/"rt-context"). */
export const RT_CONTEXT_EXTENSION_ID = "local.rt-context";

export interface UninstallSeams {
  detectEditors: () => DetectedEditor[];
}

const REAL_UNINSTALL_SEAMS: UninstallSeams = { detectEditors };

function ourLinkNames(p: Probes): string[] {
  return p.readDir(join(p.home, ".local", "bin")).filter((name) => isOurLink(p, name));
}

/** Same shape `path.link`'s own repairShellWrapper/removeShellIntegration read — real fs, call-time HOME (never Probes; shell-integration.ts has no Probes seam of its own, see that module's docblock). */
function shellRcHasMarker(): boolean {
  const rcPath = shellRcPath(detectShell());
  if (!rcPath || !existsSync(rcPath)) return false;
  try {
    return readFileSync(rcPath, "utf8").includes(MARKER);
  } catch {
    return false;
  }
}

/**
 * The v1 uninstall action list, in the contract's fixed order. Every gate is
 * "is there really something here to remove" — a fresh or partially-installed
 * machine naturally produces a shorter list, never a placeholder action for
 * work that would be a no-op.
 */
export function computeUninstallActions(p: Probes, opts: { keepData: boolean }, seams: UninstallSeams = REAL_UNINSTALL_SEAMS): UninstallAction[] {
  const actions: UninstallAction[] = [];

  actions.push({ id: "services.unregister", title: "Stop and remove the rt daemon and deck services", kind: "app" });

  if (resolveTool(p, "deck").chosen !== null) {
    actions.push({ id: "deck.managed-remove", title: "Remove board and gitq from deck", kind: "rt" });
  }

  if (p.exists(PORTLESS_LAUNCHD_PLIST)) {
    actions.push({ id: "proxy.remove", title: "Remove the local HTTPS proxy (admin prompt)", kind: "privileged" });
  }

  if (ourLinkNames(p).length > 0) {
    actions.push({ id: "path.unlink", title: "Remove ~/.local/bin links", kind: "rt" });
  }

  if (shellRcHasMarker()) {
    actions.push({ id: "shell.remove", title: "Remove the shell rc block", kind: "rt" });
  }

  const state = readSetupState(p);

  if (state.extensionEditors.length > 0 || seams.detectEditors().length > 0) {
    actions.push({ id: "extension.uninstall", title: "Uninstall the rt-context editor extension", kind: "rt" });
  }

  if (state.plugins.length > 0 || state.marketplaces.length > 0) {
    actions.push({ id: "plugins.uninstall", title: "Uninstall the mattstack plugins from Claude Code", kind: "rt" });
  }

  if (!opts.keepData) {
    actions.push({ id: "data", title: "Delete ~/.mattstack (settings, teams, secrets)", kind: "rt" });
  }

  if (appBundlePath(p) !== null) {
    actions.push({ id: "app.trash", title: "Move mattstack.app to the Trash", kind: "rt" });
  }

  return actions;
}

// ─── per-action bodies ──────────────────────────────────────────────────────

interface ActionResult {
  outcome: StepOutcome;
  /** Extra lines for the caller's `stayed` summary — a manual-removal case (shell.remove's un-markered block) that isn't itself a failure. */
  stayed?: string[];
}

async function servicesUnregisterRun(ctx: ApplyContext): Promise<ActionResult> {
  const { plists, deckOmitted } = servicePlists(currentMode(), ctx.p);
  if (deckOmitted) ctx.log("services.unregister", "deck not bundled yet — only the daemon is unregistered");

  const reply = await ctx.need("services.unregister", { type: "app-unregister-services", plists });
  const outcome = needOutcome(reply, ctx, {
    noAppDetail: "mattstack.app not running — open it to remove background services",
    noAppRemedy: "Open mattstack.app, then Retry",
    timeoutRemedy: "Retry with mattstack.app running",
  });
  if (outcome.state === "done") markDaemonUninstalled();
  return { outcome };
}

/** deck's own vocabulary for "there was nothing here to unmanage" — matched as substrings since the real CLI wraps them in a sentence, mirroring deck.ts's own FROZEN_ADOPT_ERRORS pattern. */
const DECK_NOTHING_TO_REMOVE = /not managed|not found|unknown app|no such app/i;

async function deckManagedRemoveRun(ctx: ApplyContext): Promise<ActionResult> {
  const port = readDeckApiPort(ctx);
  const healthy = port !== null && (await deckIsHealthy(ctx, port));
  if (!healthy) return { outcome: { state: "skipped", detail: "deck is not running — nothing to unmanage" } };

  const exec = resolveTool(ctx.p, "deck").exec;
  if (!exec) return { outcome: { state: "skipped", detail: "deck not resolvable" } };

  const notes: string[] = [];
  let hardFailure = false;
  for (const name of ["board", "gitq"] as const) {
    const res = await ctx.p.exec([...exec, "remove", "--managed", name]);
    if (res.code === 0) {
      notes.push(`${name} removed`);
      continue;
    }
    const combined = `${res.stdout}\n${res.stderr}`;
    if (DECK_NOTHING_TO_REMOVE.test(combined)) {
      notes.push(`${name}: nothing to remove`);
      continue;
    }
    hardFailure = true;
    notes.push(`${name}: deck remove --managed exited ${res.code}`);
  }

  if (hardFailure) return { outcome: { state: "failed", detail: notes.join("; "), remedy: "Retry" } };
  return { outcome: { state: "done", detail: notes.join("; ") } };
}

async function proxyRemoveRun(ctx: ApplyContext): Promise<ActionResult> {
  if (!ctx.p.exists(PORTLESS_LAUNCHD_PLIST)) return { outcome: { state: "skipped", detail: "local proxy not installed" } };

  const reply = await ctx.need("proxy.remove", { type: "app-privileged", op: "proxy-remove" });
  const outcome = needOutcome(reply, ctx, {
    noAppDetail: "mattstack.app not running — open it to remove the local proxy",
    noAppRemedy: "Open mattstack.app, then Retry",
    timeoutRemedy: "Retry with mattstack.app running",
  });
  return { outcome };
}

async function pathUnlinkRun(ctx: ApplyContext): Promise<ActionResult> {
  const removed: string[] = [];
  const seen = new Set<string>();

  for (const tool of DEFAULT_EXPOSED) {
    seen.add(tool);
    if (unlink(ctx.p, tool).removed) removed.push(tool);
  }

  const dir = join(ctx.p.home, ".local", "bin");
  for (const name of ctx.p.readDir(dir)) {
    if (seen.has(name) || !isOurLink(ctx.p, name)) continue;
    if (unlink(ctx.p, name).removed) removed.push(name);
  }

  return { outcome: { state: "done", detail: removed.length > 0 ? `removed: ${removed.join(", ")}` : "nothing to remove" } };
}

async function shellRemoveRun(): Promise<ActionResult> {
  const shellResult = removeShellIntegration();
  const zshenvResult = removeZshenvPrecedence();

  const stayed: string[] = [];
  if (shellResult.manual) stayed.push("shell rc block needs manual removal (written before the removable marker existed)");
  if (zshenvResult.manual) stayed.push("~/.zshenv PATH block needs manual removal (written before the removable marker existed)");

  const detail = [
    shellResult.removed ? "rc block removed" : shellResult.manual ? "rc block: manual removal needed" : "no rc block found",
    zshenvResult.removed ? "zshenv block removed" : zshenvResult.manual ? "zshenv block: manual removal needed" : "no zshenv block found",
  ].join(" · ");

  return { outcome: { state: "done", detail }, stayed: stayed.length > 0 ? stayed : undefined };
}

/** Same "nothing installed" tolerance the install side (`isAlready`) uses, inverted for uninstall's own phrasing. */
function isAlreadyGone(res: { stdout: string; stderr: string }): boolean {
  return /not installed|not found|no such extension|unknown extension/i.test(`${res.stdout}\n${res.stderr}`);
}

async function extensionUninstallRun(ctx: ApplyContext, seams: UninstallSeams = REAL_UNINSTALL_SEAMS): Promise<ActionResult> {
  const editors = seams.detectEditors();
  if (editors.length === 0) {
    // No editor exists to uninstall from — whatever setup-state recorded is
    // now stale by definition. Clear it here too, not just on the happy
    // path, so a deleted editor doesn't keep this action in every future
    // plan forever.
    updateSetupState(ctx.p, (s) => ({ ...s, extensionEditors: [] }));
    return { outcome: { state: "skipped", detail: "no editor found" } };
  }

  const uninstalled: string[] = [];
  const failed: string[] = [];
  for (const editor of editors) {
    const res = await ctx.p.exec([editor.cliPath, "--uninstall-extension", RT_CONTEXT_EXTENSION_ID]);
    if (res.code === 0 || isAlreadyGone(res)) uninstalled.push(editor.name);
    else failed.push(`${editor.name} (exit ${res.code})`);
  }

  updateSetupState(ctx.p, (s) => ({ ...s, extensionEditors: s.extensionEditors.filter((e) => !uninstalled.includes(e)) }));

  if (failed.length > 0) {
    return { outcome: { state: "failed", detail: `uninstalled from ${uninstalled.join(", ") || "(none)"}; failed: ${failed.join(", ")}`, remedy: "Uninstall the extension manually, then Retry" } };
  }
  return { outcome: { state: "done", detail: `uninstalled from ${uninstalled.join(", ") || "(none)"}` } };
}

async function pluginsUninstallRun(ctx: ApplyContext): Promise<ActionResult> {
  const claude = resolveTool(ctx.p, "claude");
  if (!claude.exec) return { outcome: { state: "skipped", detail: "claude not found" } };

  const state = readSetupState(ctx.p);
  if (state.plugins.length === 0 && state.marketplaces.length === 0) {
    return { outcome: { state: "skipped", detail: "nothing recorded to remove" } };
  }

  const configDirs = claudeConfigDirs(ctx.p, []);
  const notes: string[] = [];

  for (const dir of configDirs) {
    const env = { CLAUDE_CONFIG_DIR: dir };
    for (const plugin of state.plugins) {
      const res = await ctx.p.exec([...claude.exec, "plugin", "uninstall", plugin], { env });
      if (res.code !== 0 && !isAlreadyGone(res)) notes.push(`${dir}: uninstall ${plugin} exited ${res.code}`);
    }
    for (const marketplace of state.marketplaces) {
      const res = await ctx.p.exec([...claude.exec, "plugin", "marketplace", "remove", marketplace], { env });
      if (res.code !== 0 && !isAlreadyGone(res)) notes.push(`${dir}: marketplace remove ${marketplace} exited ${res.code}`);
    }
  }

  updateSetupState(ctx.p, (s) => ({ ...s, plugins: [], marketplaces: [] }));

  if (notes.length > 0) return { outcome: { state: "failed", detail: notes.join("; "), remedy: "Retry" } };
  return { outcome: { state: "done", detail: `removed ${state.plugins.length} plugin(s), ${state.marketplaces.length} marketplace(s) across ${configDirs.length} config dir(s)` } };
}

function mattstackDataDir(p: Pick<Probes, "home">): string {
  return join(p.home, ".mattstack");
}

/**
 * Refuses BEFORE removing anything: an unsafe `home` (empty, "/", or
 * relative — a relative HOME would turn `removeDir` into deleting
 * `.mattstack` relative to whatever the process's CWD happens to be, not
 * this machine's real data) would turn `removeDir` into deleting far more
 * than this machine's mattstack data. Validates both the input (`home`) and
 * the resolved target's shape (mirrors `appTrashRun`'s own target-shape
 * check below) — validate first, remove second.
 */
async function dataRun(ctx: ApplyContext): Promise<ActionResult> {
  const dir = mattstackDataDir(ctx.p);
  const homeUnsafe = !ctx.p.home || ctx.p.home.trim() === "" || ctx.p.home === "/" || !isAbsolute(ctx.p.home);
  if (homeUnsafe || basename(dir) !== ".mattstack") {
    return { outcome: { state: "failed", detail: `refusing to delete ${dir} — HOME resolved to an unsafe value ("${ctx.p.home}")` } };
  }
  if (!ctx.p.exists(dir)) return { outcome: { state: "skipped", detail: `${dir} does not exist` } };

  ctx.p.removeDir(dir);
  return { outcome: { state: "done", detail: `removed ${dir}` } };
}

/** Refuses BEFORE trashing anything: `appBundlePath` only ever resolves to a real ".app" bundle root, but this still validates the shape rather than trusting a computed path blindly. */
async function appTrashRun(ctx: ApplyContext): Promise<ActionResult> {
  const appPath = appBundlePath(ctx.p);
  if (!appPath) return { outcome: { state: "skipped", detail: "no app bundle found" } };
  if (appPath === "/" || appPath.trim() === "" || !appPath.endsWith(".app")) {
    return { outcome: { state: "failed", detail: `refusing to trash "${appPath}" — does not look like an app bundle` } };
  }

  const script = `tell application "Finder" to delete POSIX file "${appPath.replace(/"/g, '\\"')}"`;
  const res = await ctx.p.exec(["osascript", "-e", script]);
  if (res.code !== 0) {
    return { outcome: { state: "failed", detail: `osascript exited ${res.code}: ${(res.stderr || res.stdout).trim()}`, remedy: "Drag mattstack.app to the Trash yourself" } };
  }
  return { outcome: { state: "done", detail: `moved ${appPath} to the Trash` } };
}

async function runAction(ctx: ApplyContext, id: UninstallActionId, seams: UninstallSeams): Promise<ActionResult> {
  switch (id) {
    case "services.unregister":
      return servicesUnregisterRun(ctx);
    case "deck.managed-remove":
      return deckManagedRemoveRun(ctx);
    case "proxy.remove":
      return proxyRemoveRun(ctx);
    case "path.unlink":
      return pathUnlinkRun(ctx);
    case "shell.remove":
      return shellRemoveRun();
    case "extension.uninstall":
      return extensionUninstallRun(ctx, seams);
    case "plugins.uninstall":
      return pluginsUninstallRun(ctx);
    case "data":
      return dataRun(ctx);
    case "app.trash":
      return appTrashRun(ctx);
    default:
      // "cron.uninstall" and any future id — never generated by
      // computeUninstallActions today, kept here only so the switch stays
      // exhaustive over UninstallActionId without a `never` cast.
      return { outcome: { state: "failed", detail: `no uninstall handler for "${id}"` } };
  }
}

function stepEventFields(outcome: StepOutcome): { detail?: string; remedy?: string } {
  if (outcome.state === "failed") return { detail: outcome.detail, ...(outcome.remedy !== undefined ? { remedy: outcome.remedy } : {}) };
  return outcome.detail !== undefined ? { detail: outcome.detail } : {};
}

/**
 * Runs `actions` in order, emitting the same NDJSON event shapes
 * `runApplyWith` does. No action may crash this run: every body above is
 * wrapped here too, so a library throwing a plain (non-`UserActionableError`)
 * exception still ends the run cleanly with a `failed` outcome and a `done`
 * event, never an uncaught rejection mid-uninstall.
 */
export async function runUninstall(ctx: ApplyContext, actions: UninstallAction[], seams: UninstallSeams = REAL_UNINSTALL_SEAMS): Promise<{ ok: boolean; failed?: UninstallActionId; stayed: string[] }> {
  ctx.emit({ event: "plan", steps: actions.map((a) => ({ id: a.id, title: a.title, kind: a.kind })) });

  const stayed: string[] = [];
  if (!actions.some((a) => a.id === "data")) stayed.push("~/.mattstack (kept)");

  let result: { ok: boolean; failed?: UninstallActionId } = { ok: true };

  for (const action of actions) {
    ctx.emit({ event: "step", id: action.id, state: "running" });

    let run: ActionResult;
    try {
      run = await runAction(ctx, action.id, seams);
    } catch (err) {
      run = { outcome: toFailedOutcome(err) };
    }

    if (run.stayed) stayed.push(...run.stayed);
    ctx.emit({ event: "step", id: action.id, state: run.outcome.state, ...stepEventFields(run.outcome) });

    if (run.outcome.state === "failed") {
      result = { ok: false, failed: action.id };
      break;
    }
  }

  ctx.emit({ event: "done", ok: result.ok, ...(result.failed !== undefined ? { failedStep: result.failed } : {}) });
  return { ...result, stayed };
}
