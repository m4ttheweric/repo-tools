/**
 * The repository room `rt chat sign-in` joins: shared by the CLI's own
 * git-derived sign-in (`deriveRoomForCwd`, in the sibling chat-room-cli.ts)
 * and the daemon's `--pane` sign-in (`deriveRoomForCwdAsync`, below), so the
 * two never land an agent in a different room for the same repo (fix round 2
 * -- the daemon previously derived its own room from the index-based
 * `repoForCwd` label alone, which diverges from this codec on every
 * path-kind identity: `repoForCwd` yields the bare worktree basename, e.g.
 * "gamma", where this module's two-segment rule yields "pool-gamma"
 * specifically to avoid the cross-repo pool-slot collision a bare basename
 * reintroduces).
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
import { deriveRepoIdentity, type RepoIdentity } from "./settings/identity.ts";
import { slugifyChatName } from "./chat-room-name.ts";
import { runCapture } from "./subprocess.ts";

export function roomForIdentity(id: RepoIdentity): string {
  if (id.kind === "remote") {
    const last = id.id.split("/").pop() ?? id.id;
    return slugifyChatName(last);
  }
  const segments = id.id.split("/").filter(Boolean);
  return slugifyChatName(segments.slice(-2).join("-"));
}

/**
 * The daemon's counterpart to `deriveRoomForCwd` (chat-room-cli.ts): the SAME
 * identity -> `roomForIdentity` codec, so parity holds, but resolved
 * through the async exec seam with a bounded timeout (mirrors
 * lib/repo-for-cwd.ts's `branchForCwd`) instead of `getRepoRoot`'s sync
 * spawn -- the daemon thread must never sync-exec (MAT-222). The toplevel
 * probe here is what actually answers "is `cwd` even a git work tree":
 * `deriveRepoIdentity` (packages/rt-client/src/settings/identity.ts) never
 * returns null -- given a non-repo path it degrades to a path-kind identity
 * off that literal path instead, which would derive a bogus room for a
 * scratch directory. `deriveRepoIdentity` also does none of
 * `getRepoIdentityForRoot`'s side-effecting writes (no `mkdirSync`, no
 * `updateRepoIndex`): it only reads the machine settings store for fork
 * overrides, so there is nothing here for a read-only HOME to fail on.
 */
export async function deriveRoomForCwdAsync(cwd: string, exec: typeof runCapture = runCapture): Promise<string | null> {
  const top = await exec(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 2_000 });
  if (top.exitCode !== 0) return null;
  const root = top.stdout.trim();
  if (!root) return null;
  const identity = await deriveRepoIdentity(root);
  return roomForIdentity(identity);
}
