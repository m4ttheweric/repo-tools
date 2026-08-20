#!/usr/bin/env bun

/**
 * rt — Zero-footprint repo CLI.
 *
 * All command navigation is handled by the command tree dispatcher.
 * Commands register declaratively; the dispatcher handles screen clearing,
 * breadcrumb headers, fzf pickers, and repo context.
 *
 * Usage:
 *   rt                        interactive menu
 *   rt daemon status          direct subcommand
 *   rt daemon                 subcommand picker
 *   rt build                  direct command
 */

import { dispatch } from "./lib/command-tree.ts";
import { TREE } from "./lib/command-tree-def.ts";
import { rtDir, migrateLegacyRtDir, LEGACY_RT_LABEL, RT_DIR_LABEL, trayAppPath } from "./lib/rt-paths.ts";

const args = process.argv.slice(2);

// The generated PATH shims (lib/endpoint/shim.ts) exec
// `rt intercept run <command> -- "$@"` for every intercepted invocation, and
// that path must be byte-transparent — its stderr belongs to the wrapped
// command, not to rt. Decided here, before the migration block below, because
// that block is the first thing on the entry path that prints.
const isInterceptRun = args[0] === "intercept" && args[1] === "run";

// ─── Legacy state migration (RT-46) ──────────────────────────────────────────
// Move a real legacy rt dir into place BEFORE anything (the CLI logger
// included) can create the new tree and turn a clean rename into a conflict.
// The daemon entry runs its own copy of this (lib/daemon.ts) for the
// `bun run lib/daemon.ts` source path; the call is idempotent.
//
// The migration itself runs on EVERY entry path, intercepts included — an
// intercepted command really can be the first rt invocation after an upgrade,
// and skipping it there would leave the state split. Only the reporting is
// suppressed for intercepts: the one-shot "migrated" line would corrupt a
// wrapped command's stderr once, and the "conflict" warning would do it on
// every single invocation until a human merges the trees.
{
  const migration = migrateLegacyRtDir();
  if (isInterceptRun) {
    // silent — see above
  } else if (migration === "migrated") {
    console.error(`  rt: migrated legacy ${LEGACY_RT_LABEL} state to ${RT_DIR_LABEL}`);
  } else if (migration === "conflict") {
    console.error(`\n  rt: WARNING — state is split between ${LEGACY_RT_LABEL} and ${RT_DIR_LABEL}.`);
    console.error(`  rt reads only ${RT_DIR_LABEL}; merge the legacy ${LEGACY_RT_LABEL} directory into it by hand, then delete it.\n`);
  }
}

// ─── Command Tree ────────────────────────────────────────────────────────────
//
// Branch nodes: have subcommands → dispatcher shows a picker
// Leaf nodes: have module/fn → dispatcher lazy-imports and calls the handler
//
// The tree lives in ./lib/command-tree-def.ts as the single source of truth
// for command names, descriptions, and structure. Handlers are lazy-loaded.

// ─── Entry ───────────────────────────────────────────────────────────────────

// Injected at compile time via `bun build --define RT_VERSION='"v1.x.x"'`.
// Falls back to "dev" when running from source.
declare const RT_VERSION: string;
const _RT_VERSION = (typeof RT_VERSION !== "undefined" ? RT_VERSION : null) ?? process.env.RT_VERSION ?? "dev";

const baseDir = import.meta.dir; // resolve module paths relative to cli.ts

// Invocation logging + crash capture for every CLI entry path, including the
// ~100 process.exit() sites that never return to dispatch(). The daemon path
// is excluded — it installs its own pino crash handlers.
if (args[0] !== "--daemon") {
  const { installCliLogging } = await import("./lib/cli-logger.ts");
  installCliLogging(args);
}

if (args[0] === "--version" || args[0] === "-V") {
  console.log(`rt ${_RT_VERSION}`);
} else if (args[0] === "--daemon") {
  // Hidden entry point: start the daemon server directly.
  // Used when rt is a compiled binary — daemon install spawns `rt --daemon`
  // instead of `bun run lib/daemon.ts`.
  const { startDaemon } = await import("./lib/daemon.ts");
  startDaemon();
} else if (isInterceptRun) {
  // Hidden fast path: the generated PATH shims (lib/endpoint/shim.ts) exec
  // `rt intercept run <command> -- "$@"` for every intercepted invocation
  // (e.g. `pnpm start`), and that MUST be byte-transparent — no screen
  // clear, no breadcrumb banner (dispatch()'s leaf-node ceremony), no
  // first-run setup, no plugin-tree load/skip notices. Bypass all of that
  // and call the handler directly, same tier as --daemon/--post-install.
  const { interceptRun } = await import("./commands/intercept.ts");
  await interceptRun(args.slice(2));
} else if (args[0] === "--post-install") {
  // Hidden entry point: called by the Homebrew formula's post_install hook.
  // Handles tray app, extension install, daemon setup, and shell integration.
  const { runPostInstall } = await import("./commands/post-install.ts");
  await runPostInstall();
} else if (args[0] === "--grant-fda") {
  // Hidden entry point: open System Settings → Privacy → Full Disk Access.
  // The daemon inherits TCC grants from mattstack.app via SMAppService's
  // AssociatedBundleIdentifiers, so the grant goes on the tray app, not on rt.
  const { execSync } = await import("child_process");
  const trayPath = trayAppPath();
  console.log("\n  Opening System Settings → Privacy → Full Disk Access…\n");
  console.log(`  1. Click ${"\x1b[1m"}+${"\x1b[0m"} and add: ${"\x1b[1m"}${trayPath}${"\x1b[0m"}`);
  console.log(`     (the rt daemon inherits this grant via SMAppService)`);
  console.log(`  2. Restart the daemon: ${"\x1b[1m"}rt daemon restart${"\x1b[0m"}\n`);
  try {
    execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"');
  } catch {
    console.error("  Could not open System Settings — open it manually: System Settings → Privacy & Security → Full Disk Access");
    process.exit(1);
  }
} else if (args[0] === "update") {
  // `update` bypasses first-run setup — its own post-upgrade step runs it.
  const { runUpdate } = await import("./commands/update.ts");
  await runUpdate(args.slice(1));
  process.exit(0);
} else {
  // ── First-run auto-setup ──────────────────────────────────────────────────
  // If daemon.json doesn't exist, post-install hasn't completed outside the
  // Homebrew sandbox. Run it now transparently before the requested command.
  // This also applies to `rt verify`, which is the command we recommend users
  // run after `brew install` — it should set up + then verify in one shot.
  if (process.env.CI !== "true" && process.env.RT_SKIP_SETUP !== "1") {
    const { existsSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");
    if (!existsSync(join(rtDir(), "daemon.json"))) {
      console.log("\n  rt — first run detected, completing setup…\n");
      const { runPostInstall } = await import("./commands/post-install.ts");
      await runPostInstall();
    }
  }

  if (args[0] === "verify") {
    const { runVerify } = await import("./commands/verify.ts");
    await runVerify(args.slice(1));
    process.exit(0);
  }

  // ── Command dispatch ────────────────────────────────────────────────────
  // User plugins merge into the tree at the root; built-ins always win.
  // ExecFailure propagates a plugin exec target's exit code as rt's own
  // (dispatch has already logged the error outcome by the time it rethrows).
  const { loadPluginTree, ExecFailure } = await import("./lib/plugins.ts");
  const fullTree = loadPluginTree(TREE);
  try {
    if (args[0] === "--help" || args[0] === "-h") {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: false });
      await dispatch(fullTree, [], ["rt"], baseDir);
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY });
    } else {
      await dispatch(fullTree, args, ["rt"], baseDir);
    }
  } catch (err) {
    if (err instanceof ExecFailure) process.exit(err.code);
    throw err;
  }
}
