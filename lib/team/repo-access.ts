/**
 * The one read of what a joiner's credentials can see. `no-account` requires
 * both halves of the evidence: git had nothing to offer AND rt holds no token
 * of its own. Either alone is only a could-not-determine.
 */

import { gitUsable } from "../setup/home-git.ts";
import type { Probes } from "../setup/probes.ts";
import { gitWithToken } from "./git-credential.ts";
import { tokenOrNull, type ForgeTokenLookup } from "./forge-token.ts";
import { withoutUrls } from "./redact.ts";

export type RepoAccessVerdict = { kind: "ok" | "no-clt" | "no-account" | "denied" | "unreachable" | "indeterminate"; detail: string };

/** The user-facing name of a forge, from the provider rather than the host, so an unrecognized host never renders as the wrong one. Both the row copy and the join copy read it from here. */
export function forgeLabel(provider: "github" | "gitlab" | undefined): string {
  return provider === "gitlab" ? "GitLab" : "GitHub";
}

const LS_REMOTE_TIMEOUT_MS = 15000;
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };
const AUTH_REFUSAL_PATTERN = /Authentication failed|403|Permission denied/;
const NO_CREDENTIAL_PATTERN = /could not read Username/;

export async function probeTeamRepoAccess(p: Probes, remote: string, lookup: ForgeTokenLookup): Promise<RepoAccessVerdict> {
  // Without the Command Line Tools, git is the xcode-select shim: it fails and
  // raises Apple's install dialog on every probe.
  if (!(await gitUsable(p.exec))) {
    return { kind: "no-clt", detail: "needs Apple's Command Line Tools first" };
  }

  const cmd = gitWithToken(["ls-remote", "--exit-code", remote, "HEAD"], tokenOrNull(lookup), GIT_ENV);
  const res = await p.exec(cmd.argv, { timeoutMs: LS_REMOTE_TIMEOUT_MS, env: cmd.env });
  if (res.code === 0) return { kind: "ok", detail: "reachable" };
  if (res.code === 2) return { kind: "ok", detail: "empty repo (will be initialized)" };
  if (res.code === 128) {
    if (NO_CREDENTIAL_PATTERN.test(res.stderr)) {
      if (lookup.kind === "absent") return { kind: "no-account", detail: "no forge account connected yet" };
      const why = lookup.kind === "unreadable" ? `rt could not read its own token store: ${lookup.reason}` : "rt offered its token and git still had none to send";
      return { kind: "indeterminate", detail: `couldn't determine access: ${why}` };
    }
    if (AUTH_REFUSAL_PATTERN.test(res.stderr)) return { kind: "denied", detail: "the forge refused this account" };
  }
  if (res.code === 124) return { kind: "unreachable", detail: "unreachable: git ls-remote timed out" };
  const firstLine = withoutUrls(res.stderr.trim().split("\n")[0] || `exit ${res.code}`);
  return { kind: "unreachable", detail: `unreachable: ${firstLine}` };
}
