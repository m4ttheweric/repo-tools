/**
 * Static module registry for compiled binary builds.
 *
 * bun build --compile can't resolve dynamic import(variable) calls.
 * This registry maps module paths to their static imports so the
 * command tree dispatcher works in both source and compiled modes.
 */

import * as branch from "../commands/branch.ts";
import * as branchClean from "../commands/branch-clean.ts";
import * as buildSelect from "../commands/build-select.ts";
import * as commit from "../commands/commit.ts";
import * as agent from "../commands/agent.ts";
import * as daemon from "../commands/daemon.ts";
import * as extension from "../commands/extension.ts";
import * as hooks from "../commands/hooks.ts";
import * as open from "../commands/open.ts";
import * as port from "../commands/port.ts";
import * as run from "../commands/run.ts";
import * as settings from "../commands/settings.ts";
import * as sync from "../commands/sync.ts";
import * as workspace from "../commands/workspace.ts";
import * as mr from "../commands/mr.ts";
import * as rebase from "../commands/git/rebase.ts";
import * as reset from "../commands/git/reset.ts";
import * as backup from "../commands/git/backup.ts";
import * as pull from "../commands/git/pull.ts";
import * as push from "../commands/git/push.ts";
import * as status from "../commands/status/index.tsx";
import * as cd from "../commands/cd.ts";
import * as code from "../commands/code.ts";
import * as version from "../commands/version.ts";
import * as verify from "../commands/verify.ts";
import * as update from "../commands/update.ts";
import * as doppler from "../commands/doppler.ts";
import * as nav from "../commands/nav.ts";
import * as parkingLot from "../commands/parking-lot.ts";
import * as sdm from "../commands/sdm.ts";
import * as plugin from "../commands/plugin.ts";
import * as worktree from "../commands/worktree.ts";
import * as validate from "../commands/validate.ts";
import * as cloud from "../commands/cloud.ts";

export const MODULE_REGISTRY: Record<string, any> = {
  "./commands/branch.ts": branch,
  "./commands/branch-clean.ts": branchClean,
  "./commands/build-select.ts": buildSelect,
  "./commands/commit.ts": commit,
  "./commands/agent.ts": agent,
  "./commands/daemon.ts": daemon,
  "./commands/extension.ts": extension,
  "./commands/hooks.ts": hooks,
  "./commands/open.ts": open,
  "./commands/port.ts": port,
  "./commands/run.ts": run,
  "./commands/settings.ts": settings,
  "./commands/sync.ts": sync,
  "./commands/workspace.ts": workspace,
  "./commands/mr.ts": mr,
  "./commands/git/rebase.ts": rebase,
  "./commands/git/reset.ts": reset,
  "./commands/git/backup.ts": backup,
  "./commands/git/pull.ts": pull,
  "./commands/git/push.ts": push,
  "./commands/status/index.tsx": status,
  "./commands/cd.ts": cd,
  "./commands/code.ts": code,
  "./commands/version.ts": version,
  "./commands/verify.ts": verify,
  "./commands/update.ts": update,
  "./commands/doppler.ts": doppler,
  "./commands/nav.ts": nav,
  "./commands/parking-lot.ts": parkingLot,
  "./commands/sdm.ts": sdm,
  "./commands/plugin.ts": plugin,
  "./commands/worktree.ts": worktree,
  "./commands/validate.ts": validate,
  "./commands/cloud.ts": cloud,
};
