/**
 * `rt team publish` — the push half of team creation, split out from
 * `createTeam` so Install can retry a push independently of re-scaffolding
 * (a scaffold commit that landed but never reached the remote, a token that
 * expired between create and Install).
 */

import { join } from "path";
import { UserActionableError } from "../setup/errors.ts";
import type { Probes } from "../setup/probes.ts";
import { parseOriginUrl } from "../setup/team-settings.ts";

export interface PublishTeamResult {
  remote: string;
  pushed: boolean;
  detail: string;
}

/** git's own auth-failure phrasing on a denied push — distinguishes a credentials problem (user-actionable) from every other push failure (a bug to surface as-is). */
const AUTH_FAILURE_PATTERN = /authentication failed|permission denied|could not read username|denied to|403|access denied/i;

/** Strips any URL-shaped substring (https:// or git@host:) so a denied-push message never repeats a credential-bearing remote back to the caller. */
function withoutUrls(message: string): string {
  return message.replace(/\bhttps?:\/\/\S+/g, "<remote>").replace(/\bgit@\S+:\S+/g, "<remote>");
}

async function currentOrigin(p: Probes, dir: string): Promise<string | null> {
  const raw = p.readFile(join(dir, ".git", "config"));
  return raw !== null ? parseOriginUrl(raw) : null;
}

export async function publishTeam(p: Probes, slug: string, remote: string | null): Promise<PublishTeamResult> {
  const dir = join(p.home, ".mattstack", "teams", slug);

  if (remote) {
    const setUrl = await p.exec(["git", "remote", "set-url", "origin", remote], { cwd: dir });
    if (setUrl.code !== 0) {
      const add = await p.exec(["git", "remote", "add", "origin", remote], { cwd: dir });
      if (add.code !== 0) {
        throw new Error(`git remote add origin ${remote} failed at ${dir}: ${add.stderr}`);
      }
    }
  }

  const activeRemote = remote ?? (await currentOrigin(p, dir)) ?? "";
  const push = await p.exec(["git", "push", "-u", "origin", "main"], { cwd: dir });

  if (push.code !== 0) {
    if (push.code === 128 && AUTH_FAILURE_PATTERN.test(push.stderr)) {
      throw new UserActionableError("push-denied", withoutUrls(push.stderr.trim()));
    }
    throw new Error(`git push -u origin main failed at ${dir} (exit ${push.code}): ${push.stderr}`);
  }

  return { remote: activeRemote, pushed: true, detail: push.stdout.trim() || `pushed to ${activeRemote}` };
}
