/**
 * Lazy module registry for compiled binary builds.
 *
 * bun build --compile can't resolve dynamic import(variable) — the
 * specifier must be a string literal it can see at bundle time. Each
 * entry below is `() => import("../commands/....ts")` with the path
 * spelled out literally, so the bundler still statically discovers and
 * bundles every command module, but none of them *evaluate* until a
 * command actually dispatches to it. That's what keeps `rt --version`
 * from paying for the whole command surface.
 */

export const MODULE_REGISTRY: Record<string, () => Promise<any>> = {
  "./commands/commit.ts": () => import("../commands/commit.ts"),
  "./commands/daemon.ts": () => import("../commands/daemon.ts"),
  "./commands/events.ts": () => import("../commands/events.ts"),
  "./commands/extension.ts": () => import("../commands/extension.ts"),
  "./commands/home.ts": () => import("../commands/home.ts"),
  "./commands/hooks.ts": () => import("../commands/hooks.ts"),
  "./commands/port.ts": () => import("../commands/port.ts"),
  "./commands/run.ts": () => import("../commands/run.ts"),
  "./commands/runs.ts": () => import("../commands/runs.ts"),
  "./commands/secrets.ts": () => import("../commands/secrets.ts"),
  "./commands/settings.ts": () => import("../commands/settings.ts"),
  "./commands/settings-keys.ts": () => import("../commands/settings-keys.ts"),
  "./commands/skills.ts": () => import("../commands/skills.ts"),
  "./commands/sync.ts": () => import("../commands/sync.ts"),
  "./commands/git/rebase.ts": () => import("../commands/git/rebase.ts"),
  "./commands/git/reset.ts": () => import("../commands/git/reset.ts"),
  "./commands/git/backup.ts": () => import("../commands/git/backup.ts"),
  "./commands/git/pull.ts": () => import("../commands/git/pull.ts"),
  "./commands/git/push.ts": () => import("../commands/git/push.ts"),
  "./commands/status/index.tsx": () => import("../commands/status/index.tsx"),
  "./commands/cd.ts": () => import("../commands/cd.ts"),
  "./commands/version.ts": () => import("../commands/version.ts"),
  "./commands/verify.ts": () => import("../commands/verify.ts"),
  "./commands/update.ts": () => import("../commands/update.ts"),
  "./commands/nav.ts": () => import("../commands/nav.ts"),
  "./commands/sdm.ts": () => import("../commands/sdm.ts"),
  "./commands/plugin.ts": () => import("../commands/plugin.ts"),
  "./commands/worktree.ts": () => import("../commands/worktree.ts"),
  "./commands/intercept.ts": () => import("../commands/intercept.ts"),
  "./commands/endpoint.ts": () => import("../commands/endpoint.ts"),
  "./commands/deps.ts": () => import("../commands/deps.ts"),
  "./commands/repos.ts": () => import("../commands/repos.ts"),
  "./commands/setup.ts": () => import("../commands/setup.ts"),
  "./commands/team.ts": () => import("../commands/team.ts"),
  "./commands/cron.ts": () => import("../commands/cron.ts"),
  "./commands/services.ts": () => import("../commands/services.ts"),
  "./commands/tools.ts": () => import("../commands/tools.ts"),
  "./commands/uninstall.ts": () => import("../commands/uninstall.ts"),
};
