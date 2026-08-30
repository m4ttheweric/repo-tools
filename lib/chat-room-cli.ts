/**
 * CLI-only synchronous room derivation, split out of chat-room.ts so a
 * daemon module that only needs `deriveRoomForCwdAsync` never drags
 * repo.ts's picker chain (git.ts, repo-index.ts, the lazy rt-render.tsx
 * import) in behind it merely by importing that sibling file -- see
 * lib/__tests__/no-eager-tui.test.ts's transitive daemon-graph guard.
 */
import { getRepoRoot } from "./git.ts";
import { getRepoIdentityForRoot } from "./repo.ts";
import { parseIdentity } from "./settings/identity.ts";
import { roomForIdentity } from "./chat-room.ts";

/**
 * Null when `cwd` isn't inside a git work tree at all -- the gate is a real
 * `git rev-parse`, not a directory walk, so a scratch dir with a stray
 * `.git` file never derives a bogus room. A real (sync) git spawn, via
 * `getRepoRoot`: fine for the CLI, which runs once per invocation and exits
 * -- never call this from the daemon thread (MAT-222); it must never
 * sync-exec. `deriveRoomForCwdAsync` (chat-room.ts) is the daemon's
 * counterpart.
 */
export function deriveRoomForCwd(cwd: string): string | null {
  const root = getRepoRoot(cwd);
  if (!root) return null;
  const identity = getRepoIdentityForRoot(root);
  if (!identity) return null;
  const parsed = parseIdentity(identity.identity);
  if (!parsed) return null;
  return roomForIdentity(parsed);
}
