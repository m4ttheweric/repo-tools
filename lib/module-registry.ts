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
import * as attach from "../commands/attach.ts";
import * as pickLane from "../commands/pick-lane.ts";
import * as x from "../commands/x.ts";
import * as gitx from "../commands/gitx.ts";
import * as rebase from "../commands/git/rebase.ts";
import * as reset from "../commands/git/reset.ts";
import * as backup from "../commands/git/backup.ts";
import * as pull from "../commands/git/pull.ts";
import * as runner from "../commands/runner.tsx";
import * as status from "../commands/status.tsx";
import * as mrStatus from "../commands/mr-status.tsx";
import * as cd from "../commands/cd.ts";
import * as code from "../commands/code.ts";
import * as version from "../commands/version.ts";
import * as update from "../commands/update.ts";

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
  "./commands/attach.ts": attach,
  "./commands/pick-lane.ts": pickLane,
  "./commands/x.ts": x,
  "./commands/gitx.ts": gitx,
  "./commands/git/rebase.ts": rebase,
  "./commands/git/reset.ts": reset,
  "./commands/git/backup.ts": backup,
  "./commands/git/pull.ts": pull,
  "./commands/runner.tsx": runner,
  "./commands/status.tsx": status,
  "./commands/mr-status.tsx": mrStatus,
  "./commands/cd.ts": cd,
  "./commands/code.ts": code,
  "./commands/version.ts": version,
  "./commands/update.ts": update,
};
