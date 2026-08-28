/**
 * The repository room `rt chat sign-in` joins: shared by the CLI's own
 * git-derived sign-in and the daemon's `--pane` sign-in, so the two never
 * land an agent in a different room for the same repo (fix round 2 -- the
 * daemon previously derived its own room from the index-based `repoForCwd`
 * label alone, which diverges from this codec on every path-kind identity:
 * `repoForCwd` yields the bare worktree basename, e.g. "gamma", where this
 * module's two-segment rule yields "pool-gamma" specifically to avoid the
 * cross-repo pool-slot collision a bare basename reintroduces).
 *
 * Room naming is display, never a store key -- unlike handle derivation,
 * which must never leak the serialized identity's `%2F`/`:`, a room name
 * only needs the chat charset. remote-kind takes the identity's LAST
 * segment (what people call the repo); path-kind takes the last TWO
 * segments of the main worktree realpath, because one segment alone is the
 * bare pool-slot name (`gamma`, `main`) -- the same cross-repo collision
 * handle derivation avoids. Both go through `slugifyChatName`, so the
 * result always satisfies the room charset.
 */
import { getRepoRoot } from "./git.ts";
import { getRepoIdentityForRoot } from "./repo.ts";
import { parseIdentity, type RepoIdentity } from "./settings/identity.ts";
import { slugifyChatName } from "./chat-room-name.ts";

export function roomForIdentity(id: RepoIdentity): string {
  if (id.kind === "remote") {
    const last = id.id.split("/").pop() ?? id.id;
    return slugifyChatName(last);
  }
  const segments = id.id.split("/").filter(Boolean);
  return slugifyChatName(segments.slice(-2).join("-"));
}

/**
 * Null when `cwd` isn't inside a git work tree at all -- the gate is a real
 * `git rev-parse`, not a directory walk, so a scratch dir with a stray
 * `.git` file never derives a bogus room. A real git spawn (via
 * `getRepoRoot`): acceptable here -- sign-in is rare, unlike the daemon's
 * per-request paths (pane:list, etc.) that must never sync-exec.
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
