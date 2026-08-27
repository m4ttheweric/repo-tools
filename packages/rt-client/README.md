# @mattstack/rt-client

Typed client for the [rt](https://rt.cool) daemon.

rt keeps the per-repo state a dev environment needs: worktrees, assigned ports,
tokens, dev servers, and a live event relay. This package is how other programs
read and drive that state without shelling out to the CLI and parsing text.

```bash
bun add @mattstack/rt-client
```

```ts
import { rtCommand, readProjectMRs } from '@mattstack/rt-client';

const repos = await rtCommand(['repos', 'list']);
const mrs = await readProjectMRs('group/repo');
```

Requires a running rt daemon. Install rt from the latest GitHub Release
(`./rt --post-install`), then `rt verify`.

Bun-only: the settings exec path (`src/settings/exec.ts`) shells out via
`Bun.spawn`, so this package does not run under Node.

`@mattstack/glance` is a peer dependency: rt-client returns glance's forge types
so merge request shapes stay identical across rt, gitq, and mr-board.

## Repo identity

Every per-repo key in the rt estate is a stable serialized identity, not a
repo name. Whatever you store per-repo, send to the daemon, or put in a REST
path is keyed by the wire form this package emits. The one exception:
settings-store sections (`repos.<identity>`) key on the RAW `host/path` form
(`RepoIdentity.id` for a remote-kind identity) — the settings resolver never
sees the wire form, and a serialized key there misses silently.

```text
remote:gitlab.com%2Facme%2Facme-dev     path:%2FUsers%2Fdev%2Fscratch
└─┬──┘ └──────────┬─────────────┘
 kind    the id, encodeURIComponent'd — slash-free, fits one URL segment
```

`kind` is `remote` (the repo has an origin: id is normalized `host/path`) or
`path` (no usable remote: id is the main worktree's realpath). The `:` is a
literal delimiter.

```ts
import {
  deriveRepoIdentity,   // (repoPath: string) => Promise<RepoIdentity> — never null
  serializeIdentity,    // (id: RepoIdentity) => string — the wire form above
  parseIdentity,        // (wire: string) => RepoIdentity | null — THE validity check
  identityFromRemote,   // (remoteUrl: string) => RepoIdentity | null — sync
  type RepoIdentity,    // { kind: "remote" | "path"; id: string }
} from '@mattstack/rt-client';

const identity = serializeIdentity(await deriveRepoIdentity(repoPath));

await rtCommand(['worktree', 'list', '--repo', identity]);        // daemon key
const url = `/api/runs/${encodeURIComponent(identity)}/${runId}`; // URL segment
```

| Do | Don't |
|---|---|
| Get identities from these functions, once, at the boundary | Re-derive with your own git calls (`git remote get-url` diverges under `insteadOf`) |
| Key stores and daemon payloads on the serialized form | Key anything on a folder basename or a remote's last segment |
| Key settings sections (`repos.<identity>`) on the raw `host/path` id | Put the serialized form in a settings lookup, or the raw form in a daemon payload |
| `encodeURIComponent(identity)` in URL path segments | Ship the wire form raw in a URL — its `%` signs decode into slashes |
| Decode for display: `parseIdentity(wire)`, then the id's last path segment (remote) or basename (path) — the returned `id` is already decoded | `decodeURIComponent` the id again, show the wire form to a human, or build a chat handle from it |
| Treat the `repo` field from `runs:list` as an opaque key, passed back verbatim | Validate or re-derive `runs:*` repo keys — pre-cutover runs keep their original keys |

Repo-keyed daemon verbs accept serialized identities only; a bare repo name
doesn't error, it resolves empty. `parseIdentity` is strict — only strings
`serializeIdentity` emitted parse — so validate payloads with it, and never
hand-assemble or string-split a wire.

## Chat

The `rt chat` surface the chat viewer (`~/Documents/GitHub/chat`) is built
on. Every call degrades to `{ ok: false, error }` instead of throwing, and a
daemon that is down and a daemon that refused look the same to the caller;
branch on `ok`, not on exceptions.

```ts
import { chatRooms, chatMessages, chatPost, createRelay, daemonHealth } from '@mattstack/rt-client';

const rooms = await chatRooms({ handle: 'matt' });            // { ok, data: { rooms } }
const page = await chatMessages({ room: 'build', limit: 50 }); // newest page; `before: <id>` pages older
await chatPost({ handle: 'matt', room: 'build', body: 'on it' });

const health = await daemonHealth();                           // { reachable, error? }, never throws
const stop = createRelay({                                     // one daemon subscription, republished
  match: t => t.startsWith('chat/'),                            // `chat/<room>/msg`, `chat/wake/<handle>`
  topic: 'chat',
  publish: (topic, data) => server.publish(topic, data),
});
```

| Function | Daemon verb |
| --- | --- |
| `chatSignIn` / `chatSignOut` / `chatAway` / `chatBack` / `chatPulse` | presence: the buddy-list row and its heartbeats |
| `chatBuddies` / `chatWho` / `chatRooms` | the roster, one room's members, a handle's rooms |
| `chatJoin` / `chatLeave` | membership (`wakeOn: mention \| all \| none`) |
| `chatPost` / `chatDm` / `chatRead` / `chatMessages` / `chatMark` | messages: post, DM, read-and-advance, page, advance the cursor |
| `chatArm` / `chatTouch` / `chatDisarm` / `chatUnreadWaking` | the tail's wake protocol; the CLI's `rt chat tail` uses these |
| `paneList` / `panePeek` / `paneSpawn` / `paneAccounts` / `paneDirectories` | herdr panes: list with presence joined, peek a screen, start claude in a tab, cswap accounts, directory suggestions |
| `chatInvite` | type `/chat:join <room>` into a pane; `accepted`, `queued` or `refused` |
| `createRelay` / `subscribe` | the event stream; `daemonHealth` the reachability probe |

Pass `{ sockPath }` as the trailing options to reach a non-default daemon
socket. The verbs, their payloads and the wake protocol are specified in
repo-tools `docs/superpowers/specs/2026-08-23-rt-chat-design.md` and
`2026-08-24-rt-chat-presence-design.md`; the agent-facing rules are
`skills/rt-chat/SKILL.md`.

## License

MIT
