/**
 * Static module registry for compiled binary builds.
 *
 * bun build --compile can't resolve dynamic import(variable) calls.
 * This registry maps module paths to their static imports so the
 * command tree dispatcher works in both source and compiled modes.
 */

import * as commit from "../commands/commit.ts";
import * as daemon from "../commands/daemon.ts";
import * as events from "../commands/events.ts";
import * as extension from "../commands/extension.ts";
import * as home from "../commands/home.ts";
import * as hooks from "../commands/hooks.ts";
import * as port from "../commands/port.ts";
import * as run from "../commands/run.ts";
import * as settings from "../commands/settings.ts";
import * as settingsKeys from "../commands/settings-keys.ts";
import * as sync from "../commands/sync.ts";
import * as rebase from "../commands/git/rebase.ts";
import * as reset from "../commands/git/reset.ts";
import * as backup from "../commands/git/backup.ts";
import * as pull from "../commands/git/pull.ts";
import * as push from "../commands/git/push.ts";
import * as status from "../commands/status/index.tsx";
import * as cd from "../commands/cd.ts";
import * as version from "../commands/version.ts";
import * as verify from "../commands/verify.ts";
import * as update from "../commands/update.ts";
import * as nav from "../commands/nav.ts";
import * as sdm from "../commands/sdm.ts";
import * as plugin from "../commands/plugin.ts";
import * as worktree from "../commands/worktree.ts";
import * as intercept from "../commands/intercept.ts";
import * as endpoint from "../commands/endpoint.ts";

export const MODULE_REGISTRY: Record<string, any> = {
  "./commands/commit.ts": commit,
  "./commands/daemon.ts": daemon,
  "./commands/events.ts": events,
  "./commands/extension.ts": extension,
  "./commands/home.ts": home,
  "./commands/hooks.ts": hooks,
  "./commands/port.ts": port,
  "./commands/run.ts": run,
  "./commands/settings.ts": settings,
  "./commands/settings-keys.ts": settingsKeys,
  "./commands/sync.ts": sync,
  "./commands/git/rebase.ts": rebase,
  "./commands/git/reset.ts": reset,
  "./commands/git/backup.ts": backup,
  "./commands/git/pull.ts": pull,
  "./commands/git/push.ts": push,
  "./commands/status/index.tsx": status,
  "./commands/cd.ts": cd,
  "./commands/version.ts": version,
  "./commands/verify.ts": verify,
  "./commands/update.ts": update,
  "./commands/nav.ts": nav,
  "./commands/sdm.ts": sdm,
  "./commands/plugin.ts": plugin,
  "./commands/worktree.ts": worktree,
  "./commands/intercept.ts": intercept,
  "./commands/endpoint.ts": endpoint,
};
