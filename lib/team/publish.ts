/**
 * `rt team publish` — the push half of team creation, split out from
 * `createTeam` so Install can retry a push independently of re-scaffolding
 * (a scaffold commit that landed but never reached the remote, a token that
 * expired between create and Install).
 */

import { gitWithToken } from "./git-credential.ts";
import { join } from "path";
import { validateSlug } from "../secrets/store.ts";
import { UserActionableError } from "../setup/errors.ts";
import type { ExecResult, Probes } from "../setup/probes.ts";
import { parseOriginUrl, stripUserinfo } from "../setup/team-settings.ts";
import { withoutUrls } from "./redact.ts";

export interface PublishTeamResult {
  remote: string;
  pushed: boolean;
  detail: string;
}

/** git's own auth-failure phrasing on a denied push — distinguishes a credentials problem (user-actionable) from every other push failure. Exported for join.ts, which classifies `git ls-remote`/`git clone` failures the same way. */
export const AUTH_FAILURE_PATTERN = /authentication failed|permission denied|could not read username|denied to|403|access denied/i;

/** git's non-fast-forward rejection — the contract requires an existing EMPTY repo, so this specific shape means the pasted/created remote already has commits, not a generic push failure. */
const REJECTED_PATTERN = /\[rejected\]|fetch first|non-fast-forward|failed to push some refs/i;

/** Classifies a failed `git push` into a typed, redacted error — never a plain `Error` that would crash the caller instead of rendering. */
function classifyPushFailure(result: ExecResult): UserActionableError {
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.code === 128 && AUTH_FAILURE_PATTERN.test(text)) {
    return new UserActionableError("push-denied", withoutUrls(text.trim()));
  }
  if (REJECTED_PATTERN.test(text)) {
    return new UserActionableError(
      "remote-not-empty",
      `the remote already has commits rt can't fast-forward past — rt team create expects an existing EMPTY repository: ${withoutUrls(text.trim())}`,
    );
  }
  return new UserActionableError("push-failed", `git push -u origin main failed (exit ${result.code}): ${withoutUrls(text.trim())}`);
}

async function currentOrigin(p: Probes, dir: string): Promise<string | null> {
  const raw = p.readFile(join(dir, ".git", "config"));
  return raw !== null ? parseOriginUrl(raw) : null;
}

export async function publishTeam(p: Probes, slug: string, remote: string | null, opts: { token?: string | null } = {}): Promise<PublishTeamResult> {
  try {
    validateSlug(slug);
  } catch (err) {
    // validateSlug's own error isn't a UserActionableError — this is the one
    // place that would let an unvalidated `--team ../../some-repo` resolve
    // to a directory outside teamsDir() and run git there.
    throw new UserActionableError("invalid-team-slug", err instanceof Error ? err.message : String(err));
  }

  const dir = join(p.home, ".mattstack", "teams", slug);
  if (!p.exists(dir)) {
    throw new UserActionableError("no-team-zone", `no team zone for "${slug}" at ${dir} — run \`rt team create\` first`);
  }

  if (remote) {
    const setUrl = await p.exec(["git", "remote", "set-url", "origin", remote], { cwd: dir });
    if (setUrl.code !== 0) {
      const add = await p.exec(["git", "remote", "add", "origin", remote], { cwd: dir });
      if (add.code !== 0) {
        throw new UserActionableError("git-remote-failed", `git remote add origin failed (exit ${add.code}): ${withoutUrls(`${add.stdout}\n${add.stderr}`.trim())}`);
      }
    }
  }

  const activeRemote = remote ?? (await currentOrigin(p, dir)) ?? "";
  const cmd = gitWithToken(["push", "-u", "origin", "main"], opts.token ?? null, { GIT_TERMINAL_PROMPT: "0" });
  const push = await p.exec(cmd.argv, { cwd: dir, env: cmd.env });

  if (push.code !== 0) throw classifyPushFailure(push);

  const publicRemote = stripUserinfo(activeRemote);
  const stdout = push.stdout.trim();
  return { remote: publicRemote, pushed: true, detail: stdout ? withoutUrls(stdout) : `pushed to ${publicRemote}` };
}
