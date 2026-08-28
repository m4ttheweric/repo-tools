/**
 * Reply shape for a command name routeCommand's switch doesn't recognize.
 * Carries the daemon's own version so a caller can tell version skew (the
 * daemon is older than the CLI/client that sent the command) from a genuine
 * typo.
 */
export function unknownCommandReply(cmd: string, version: string) {
  return {
    ok: false as const,
    code: "unknown-command" as const,
    version,
    error: `daemon at version ${version} does not know "${cmd}"; restart or upgrade rt (rt daemon restart)`,
  };
}
