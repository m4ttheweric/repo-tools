/**
 * `git.identity` writes the global git identity from the connected forge
 * account when the machine has none. A fresh Mac has no `user.name`/
 * `user.email` at all, so every commit made there (the snapshot daemon's and
 * the operator's alike) carries git's auto-derived `<full name> <user@host>`
 * instead of the person's own.
 *
 * Only unset keys are written: an identity the operator already chose is
 * theirs, not rt's to correct. Everything short of an unwritable
 * `~/.gitconfig` reports `skipped` with the two commands a human can run,
 * since an author line must never stop an install. Uninstall leaves the
 * identity in place for the same reason.
 */

import { forgeProfile } from "../../team/forge.ts";
import type { ApplyContext, StepDef, StepOutcome } from "../apply.ts";
import { isValidHostname } from "../host-validate.ts";
import { forgeFromHost, forgeFromRemote, readUserIntegrationOverrides } from "../team-settings.ts";
import { forgeTokenFor } from "./forge-token.ts";
import { toFailedOutcome } from "./step-utils.ts";

type IdentityKey = "user.name" | "user.email";

const MANUAL = "run git config --global user.name / user.email";

async function readGlobal(ctx: ApplyContext, key: IdentityKey): Promise<string | null> {
  // git exits 1 for a key that is simply unset, which is not an error here.
  const result = await ctx.p.exec(["git", "config", "--global", key]);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

/** Null on success; git's own words on failure. */
async function writeGlobal(ctx: ApplyContext, key: IdentityKey, value: string): Promise<string | null> {
  const result = await ctx.p.exec(["git", "config", "--global", key, value]);
  if (result.code === 0) return null;
  const text = `${result.stderr}\n${result.stdout}`.trim();
  return text.length > 0 ? `git config --global ${key}: ${text}` : `git config --global ${key} exited ${result.code}`;
}

/**
 * `forgeTokenFor` derives the token's key from the host inside a full remote
 * URL, and a bare `https://host/` does not parse as one. The path segment is
 * inert: only the host decides which token rt holds.
 */
function tokenRemoteFor(host: string): string {
  return `https://${host}/mattstack/identity`;
}

/**
 * The forge the user confirmed for themselves during `rt setup <id> connect`,
 * which is all a machine with no team has. Hostname-validated like every
 * other reader of this key: nothing but a real host may reach `gh`/`glab`.
 */
function connectedForge(): { host: string; provider: "github" | "gitlab" } | null {
  const host = readUserIntegrationOverrides().forgeHost;
  return host && isValidHostname(host) ? forgeFromHost(host) : null;
}

async function gitIdentityRun(ctx: ApplyContext): Promise<StepOutcome> {
  const name = await readGlobal(ctx, "user.name");
  const email = await readGlobal(ctx, "user.email");
  if (name && email) return { state: "skipped", detail: `already configured: ${name} <${email}>` };

  const forge = ctx.snapshot?.integrations.forge ?? (ctx.snapshot?.remote ? forgeFromRemote(ctx.snapshot.remote) : null) ?? connectedForge();
  if (!forge) return { state: "skipped", detail: `no forge connected; ${MANUAL}` };

  const token = await forgeTokenFor(ctx, tokenRemoteFor(forge.host));
  if (token) ctx.redact(token);

  const profile = await forgeProfile(ctx.p, forge.provider, forge.host, token, (detail) => ctx.log("git.identity", detail));
  if (!profile) return { state: "skipped", detail: `forge profile unavailable; ${MANUAL}` };

  const remedy = "Check that ~/.gitconfig is writable, then Retry";
  if (!name) {
    const err = await writeGlobal(ctx, "user.name", profile.name);
    if (err) return { state: "failed", detail: err, remedy };
  }
  if (!email) {
    const err = await writeGlobal(ctx, "user.email", profile.email);
    if (err) return { state: "failed", detail: err, remedy };
  }

  return { state: "done", detail: `${name ?? profile.name} <${email ?? profile.email}>` };
}

async function gitIdentityRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await gitIdentityRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const gitIdentityStep: StepDef = {
  id: "git.identity",
  title: "Set your git identity",
  kind: "rt",
  applies: () => true,
  run: gitIdentityRunSafe,
};
