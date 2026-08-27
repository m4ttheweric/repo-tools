# rt chat invite, part 2: the viewer (chat)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the chat viewer, create a room, seed it, and invite or spawn herdr panes into it through a standalone pane picker; refresh members as they arrive; ship the artboards and audit that pin the new UI.

**Architecture:** The Hono server gains `/api/panes*` routes over rt-client's new pane wrappers and two `POST` chat routes (`rooms`, `invite`), all with fixtures. The client gains `PanePicker` (a provider-hosted modal with a promise-returning `usePanePicker()` hook, owning fetch, filter, sort, peek, selection and the New pane form), `NewRoomModal` (name, seed, wake mode, picked panes with notes), a `+` in the rooms rail, `add agents` in the page bar, a `who` refetch on `chat/<room>/msg` frames, and a notice row at the transcript's edge. The design artboards fold into `design/build.py`, and `audit.mjs` gains targets for every new component.

**Tech Stack:** Bun + Hono server, React 19 + Mantine 9.5 through the mantine-kit facades (`@ui/*`), vitest + Testing Library, `@mattstack/rt-client` 0.6.2, the design toolchain (`build.py`, `extract-spec.py`, `audit.mjs`, Fast Browser).

**Spec:** `~/Documents/GitHub/repo-tools-chat-invite/docs/superpowers/specs/2026-08-26-rt-chat-invite-design.md` (sections "Data flow", "Web viewer", "Failure modes", "Testing").

## Global Constraints

- Work in a worktree: `git -C ~/Documents/GitHub/chat worktree add ~/Documents/GitHub/chat-invite -b feat/pane-invite && cd ~/Documents/GitHub/chat-invite && bun install`. Never in `~/Documents/GitHub/chat` itself.
- Import walls (AGENTS.md, enforced by eslint): app code under `src/app/**` imports only `@ui/*`; code under `src/ui/**` may import `@mantine/core` directly except `Table`, `TextInput`, `CopyButton`, which come from `@ui/core`. Icons only through `@ui/icons` (`<Icon name="..." />`). Notifications through `@ui/notifications`.
- Mantine props come from the docs (`docs/mantine-llms.txt` or the `mantine` MCP), never from memory.
- No colour literals: `var(--tk-*)`, `var(--mantine-color-*)`, or `color-mix` off them, as `Composer.tsx:23-52` and `RoomRail.tsx:17-22` do. The values that matter are the artboards' (7.2px, 9.6px, 11.2px, 10.56px, 12.16px, 34px rows, 44px phone controls, 8px dots); the audit checks them.
- Paths render as `headTruncatePath(cwd)` from `src/ui/presence-bits.tsx` (`…/leaf`), never `direction: rtl`.
- Every request body is hand-parsed with `c.req.json()` in a try/catch (never `validator('json')`), and rt-client is branched on `ok`, never caught, exactly as `src/server/chat.ts:238-282`.
- `GET /api/panes` reports herdr absence as `{ available: false, panes: [] }` with 200. Every other rt failure is a 502 with `{ error }`.
- No em dashes or en dashes in new code, copy, comments, or commit messages (use `·`, `:` or a plain sentence). Comments only for constraints the code cannot show.
- Tests: `bunx vitest run <file>` while working; `bun run typecheck && bun run lint && bunx vitest run` before every commit. `bun run build` before the PR.
- Commit after every task with a short imperative message.

---

### Task 1: worktree and the rt-client with pane wrappers

**Files:**
- Modify: `package.json` (`@mattstack/rt-client` pin), `bun.lock`

**Interfaces:**
- Consumes: part 1's rt-client (`paneList`, `panePeek`, `paneSpawn`, `paneAccounts`, `paneDirectories`, `chatInvite`, types `ChatPane`, `AgentStatus`, `PaneAccount`, `PaneDirectory`, `InviteResult`).

- [ ] **Step 1: Create the worktree**

```bash
git -C ~/Documents/GitHub/chat worktree add ~/Documents/GitHub/chat-invite -b feat/pane-invite
cd ~/Documents/GitHub/chat-invite && bun install
```

- [ ] **Step 2: Point at the rt-client that has the wrappers**

If `npm view @mattstack/rt-client version` prints `0.6.2` or later: `bun add @mattstack/rt-client@^0.6.2`. Otherwise (part 1 merged but not yet published) build it locally and link it for the duration of this plan:

```bash
(cd ~/Documents/GitHub/repo-tools-chat-invite/packages/rt-client && bun run build)
bun add @mattstack/rt-client@file:../repo-tools-chat-invite/packages/rt-client
```

Verify: `grep -c 'paneSpawn\|chatInvite' node_modules/@mattstack/rt-client/dist/index.d.ts` prints at least 2, and `grep -c 'pane:spawn' node_modules/@mattstack/rt-client/dist/index.js` prints at least 1 (types without runtime is the failure mode CLAUDE.md in repo-tools warns about).

- [ ] **Step 3: Baseline**

Run: `bun run typecheck && bunx vitest run`
Expected: green before any change.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "deps: rt-client with the pane and invite wrappers"
```

(If the `file:` form was used, Task 10 swaps it back to a published pin before the PR.)

---

### Task 2: fixtures for panes, accounts, directories, invites

**Files:**
- Modify: `src/server/fixtures.ts`
- Test: `src/server/fixtures.test.ts`

**Interfaces:**
- Produces: `fixturePanes(): ChatPane[]`, `fixtureAccounts(): PaneAccount[]`, `fixtureDirectories(q?: string): PaneDirectory[]`, `fixtureInvite(paneId: string): InviteResult`, `fixtureSpawn(cwd: string): { pane: ChatPane; ready: boolean }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/fixtures.test.ts`, merging `fixtureAccounts, fixtureDirectories, fixtureInvite, fixturePanes, fixtureSpawn` into its existing `./fixtures` import (the sort-imports prettier plugin rejects a second import statement):

```ts

test('the pane fixtures cover every row state the picker artboard draws', () => {
  const panes = fixturePanes();
  const states = new Set(panes.map(p => (p.presence ? p.presence.status : 'none')));
  expect(states).toEqual(new Set(['live', 'idle', 'deaf', 'none']));
  expect(panes.some(p => p.agentStatus === 'working')).toBe(true);
  expect(panes.some(p => p.agentStatus === 'blocked')).toBe(true);
  expect(panes.some(p => p.presence?.rooms.includes('build'))).toBe(true);
  expect(panes.every(p => p.paneId && p.workspace)).toBe(true);
});

test('invite fixtures answer per pane: a working pane queues, a blocked one refuses', () => {
  const working = fixturePanes().find(p => p.agentStatus === 'working')!;
  const blocked = fixturePanes().find(p => p.agentStatus === 'blocked')!;
  const idle = fixturePanes().find(p => p.agentStatus === 'idle' && !p.presence)!;
  expect(fixtureInvite(working.paneId).delivered).toBe('queued');
  expect(fixtureInvite(blocked.paneId)).toMatchObject({ delivered: 'refused', reason: 'at a prompt' });
  expect(fixtureInvite(idle.paneId).delivered).toBe('accepted');
});

test('directories filter by substring; accounts carry headroom; spawn returns a ready pane', () => {
  expect(fixtureDirectories('acme').every(d => d.path.includes('acme'))).toBe(true);
  expect(fixtureDirectories().length).toBeGreaterThan(fixtureDirectories('acme').length);
  expect(fixtureAccounts()[0]).toMatchObject({ slot: 1, alias: 'Acme' });
  expect(fixtureSpawn('/Users/matt/Documents/GitHub/chat')).toMatchObject({ ready: true, pane: { cwd: '/Users/matt/Documents/GitHub/chat', agentStatus: 'idle' } });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/server/fixtures.test.ts`
Expected: FAIL, the named exports do not exist.

- [ ] **Step 3: Add the fixtures**

In `src/server/fixtures.ts`, add the type imports `ChatPane, InviteResult, PaneAccount, PaneDirectory` to the existing `import type { ... } from '@mattstack/rt-client'`, and append (the table is the mockup's `PANES`, so the picker fixture matches the artboard):

```ts
/** The picker artboard's rows: one per state it draws. Keep in step with
    design/build.py's PANES table. */
export function fixturePanes(): ChatPane[] {
  return [
    { paneId: 'w3f:p2', workspace: 'repo-tools', title: 'fred', cwd: '/Users/matt/Documents/GitHub/repo-tools/.claude/worktrees/rt-63-68-locate', repo: 'repo-tools', branch: 'rt-63-68-locate', agentStatus: 'working', sessionId: 'fixture-fred', presence: { handle: 'fred', status: 'live', rooms: ['repo-tools'] } },
    { paneId: 'w3f:p4', workspace: 'chat', title: 'meg', cwd: '/Users/matt/Documents/GitHub/chat', repo: 'chat', branch: 'main', agentStatus: 'idle', sessionId: 'fixture-meg', presence: { handle: 'meg', status: 'live', rooms: ['build', 'chat'] } },
    { paneId: 'w9c:p3', workspace: 'gitq', title: 'june', cwd: '/Users/matt/Documents/GitHub/gitq', repo: 'gitq', branch: 'main', agentStatus: 'blocked', sessionId: 'fixture-june', presence: { handle: 'june', status: 'idle', rooms: ['gitq'] } },
    { paneId: 'w2d:p1', workspace: 'deck', title: 'otis', cwd: '/Users/matt/Documents/GitHub/deck', repo: 'deck', branch: 'main', agentStatus: 'idle', sessionId: 'fixture-otis', presence: { handle: 'otis', status: 'deaf', rooms: ['deck'] } },
    { paneId: 'w7A:pY', workspace: 'acme', title: 'Evaluate house codegen plugin for bundle optimization', cwd: '/Users/matt/Documents/GitHub/acme', repo: 'acme', branch: 'main', agentStatus: 'idle', sessionId: 'fixture-acme' },
    { paneId: 'wB1:p1', workspace: 'mr-board', title: 'Fix invite onboarding modal focus trap', cwd: '/Users/matt/Documents/GitHub/mr-board-wt-invite-onboarding', repo: 'mr-board', branch: 'invite-onboarding', agentStatus: 'working', sessionId: 'fixture-mrboard' },
  ];
}

export function fixturePeek(paneId: string): string[] {
  if (paneId === 'w7A:pY') {
    return ['⏺ Read(src/plugins/house-codegen/index.ts)', '  ⎿  Read 212 lines', '⏺ The plugin emits one chunk per island; the split itself', '  happens in vite manualChunks, not here. Checking that next.', '❯ '];
  }
  return ['❯ '];
}

export function fixtureAccounts(): PaneAccount[] {
  return [{ slot: 1, email: 'alex@acme.test', alias: 'Acme', headroom: '5h 0% · 7d 40% · Fable 35%' }];
}

export function fixtureDirectories(q?: string): PaneDirectory[] {
  const all: PaneDirectory[] = [
    { path: '/Users/matt/Documents/GitHub/acme', repo: 'acme', branch: 'main' },
    { path: '/Users/matt/Documents/GitHub/acme-wt-codegen-split', repo: 'acme', branch: 'perf/codegen-split' },
    { path: '/Users/matt/Documents/GitHub/repo-tools', repo: 'repo-tools', branch: 'main' },
    { path: '/Users/matt/Documents/GitHub/chat', repo: 'chat', branch: 'main' },
  ];
  const needle = q?.toLowerCase();
  return needle ? all.filter(d => d.path.toLowerCase().includes(needle)) : all;
}

/** The three outcomes the invite flow renders, keyed off the pane's state. */
export function fixtureInvite(paneId: string): InviteResult {
  const pane = fixturePanes().find(p => p.paneId === paneId);
  if (!pane) return { paneId, delivered: 'refused', reason: 'not a claude pane' };
  if (pane.agentStatus === 'blocked') return { paneId, delivered: 'refused', reason: 'at a prompt' };
  if (pane.agentStatus === 'working') return { paneId, delivered: 'queued' };
  return { paneId, delivered: 'accepted' };
}

let spawned = 0;
export function fixtureSpawn(cwd: string): { pane: ChatPane; ready: boolean } {
  spawned += 1;
  const leaf = cwd.split('/').filter(Boolean).at(-1) ?? 'pane';
  return {
    ready: true,
    pane: { paneId: `wC2:p${spawned}`, workspace: 'chat', title: 'claude', cwd, repo: leaf, branch: 'main', agentStatus: 'idle' },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run src/server/fixtures.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/fixtures.ts src/server/fixtures.test.ts
git commit -m "fixtures: panes, peek, accounts, directories, invite and spawn answers"
```

---

### Task 3: the `/api/panes*` routes

**Files:**
- Create: `src/server/panes.ts`
- Modify: `src/server/app.ts` (mount)
- Test: `src/server/panes.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/panes` → `{ available: boolean; panes: ChatPane[] }`
  - `GET /api/panes/accounts` → `{ accounts: PaneAccount[] }`
  - `GET /api/panes/directories?q=` → `{ directories: PaneDirectory[] }`
  - `GET /api/panes/:id/peek?lines=8` → `{ paneId, lines }`
  - `POST /api/panes` `{ cwd, account?, model?, effort?, prompt?, workspace? }` → `{ pane, ready }`; 400 on a missing/relative `cwd` or an unknown-account error from rt.

- [ ] **Step 1: Write the failing tests**

Create `src/server/panes.test.ts`:

```ts
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('@mattstack/rt-client', () => ({
  chatRooms: vi.fn(),
  chatWho: vi.fn(),
  chatMessages: vi.fn(),
  chatMark: vi.fn(),
  chatBuddies: vi.fn(),
  chatJoin: vi.fn(),
  chatPost: vi.fn(),
  chatDm: vi.fn(),
  chatInvite: vi.fn(),
  paneList: vi.fn(),
  panePeek: vi.fn(),
  paneSpawn: vi.fn(),
  paneAccounts: vi.fn(),
  paneDirectories: vi.fn(),
  daemonHealth: vi.fn(),
  getSetting: vi.fn(() => ({ value: 'matt' })),
}));
const rt = await import('@mattstack/rt-client');
const { app } = await import('./app');

beforeEach(() => vi.resetAllMocks());

const PANE = { paneId: 'w1:p1', workspace: 'chat', agentStatus: 'idle' as const };

test('GET /api/panes passes the rows through', async () => {
  vi.mocked(rt.paneList).mockResolvedValueOnce({ ok: true, data: { panes: [PANE] } });
  const res = await app.request('/api/panes');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ available: true, panes: [PANE] });
});

test('GET /api/panes reports herdr absence as available:false with 200, and other failures as 502', async () => {
  vi.mocked(rt.paneList).mockResolvedValueOnce({ ok: false, error: 'herdr unavailable: no socket at /x' });
  const absent = await app.request('/api/panes');
  expect(absent.status).toBe(200);
  expect(await absent.json()).toEqual({ available: false, panes: [] });
  vi.mocked(rt.paneList).mockResolvedValueOnce({ ok: false, error: 'rt daemon unreachable at /x/rt.sock: ECONNREFUSED' });
  expect((await app.request('/api/panes')).status).toBe(502);
});

test('GET /api/panes/:id/peek forwards lines and returns the screen', async () => {
  vi.mocked(rt.panePeek).mockResolvedValueOnce({ ok: true, data: { paneId: 'w1:p1', lines: ['❯ '] } });
  const res = await app.request('/api/panes/w1:p1/peek?lines=4');
  expect(res.status).toBe(200);
  expect(rt.panePeek).toHaveBeenCalledWith({ paneId: 'w1:p1', lines: 4 }, expect.anything());
  expect(await res.json()).toEqual({ paneId: 'w1:p1', lines: ['❯ '] });
});

test('GET /api/panes/accounts and /directories pass through; directories forwards q', async () => {
  vi.mocked(rt.paneAccounts).mockResolvedValueOnce({ ok: true, data: { accounts: [] } });
  vi.mocked(rt.paneDirectories).mockResolvedValueOnce({ ok: true, data: { directories: [] } });
  expect((await app.request('/api/panes/accounts')).status).toBe(200);
  expect((await app.request('/api/panes/directories?q=chat')).status).toBe(200);
  expect(rt.paneDirectories).toHaveBeenCalledWith({ q: 'chat' }, expect.anything());
});

test('POST /api/panes spawns with every field and answers pane plus ready', async () => {
  vi.mocked(rt.paneSpawn).mockResolvedValueOnce({ ok: true, data: { pane: PANE, ready: true } });
  const res = await app.request('/api/panes', {
    method: 'POST',
    body: JSON.stringify({ cwd: '/repos/chat', account: 'Acme', model: 'claude-fable-5', effort: 'high', prompt: 'hi', workspace: 'chat' }),
  });
  expect(res.status).toBe(200);
  expect(rt.paneSpawn).toHaveBeenCalledWith({ cwd: '/repos/chat', account: 'Acme', model: 'claude-fable-5', effort: 'high', prompt: 'hi', workspace: 'chat' }, expect.anything());
  expect(await res.json()).toEqual({ pane: PANE, ready: true });
});

test('POST /api/panes rejects a missing or relative cwd, and maps an unknown account to 400', async () => {
  expect((await app.request('/api/panes', { method: 'POST', body: JSON.stringify({}) })).status).toBe(400);
  expect((await app.request('/api/panes', { method: 'POST', body: JSON.stringify({ cwd: 'relative' }) })).status).toBe(400);
  vi.mocked(rt.paneSpawn).mockResolvedValueOnce({ ok: false, error: 'unknown cswap account "nobody"' });
  const res = await app.request('/api/panes', { method: 'POST', body: JSON.stringify({ cwd: '/x', account: 'nobody' }) });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: 'unknown cswap account "nobody"' });
});
```

Also add `chatInvite`, `paneList`, `panePeek`, `paneSpawn`, `paneAccounts`, `paneDirectories` to the `vi.mock` factory in `src/server/chat.test.ts` (the app now imports them, and a missing mock export is `undefined` at call time).

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/server/panes.test.ts`
Expected: FAIL (404s: no routes).

- [ ] **Step 3: Write the routes**

Create `src/server/panes.ts`:

```ts
import {
  paneAccounts,
  paneDirectories,
  paneList,
  panePeek,
  paneSpawn,
  type RtClientOptions,
} from '@mattstack/rt-client';
import { Hono } from 'hono';

import {
  fixtureAccounts,
  fixtureDirectories,
  fixturePanes,
  fixturePeek,
  fixtureSpawn,
  fixturesEnabled,
} from './fixtures';

function rtOpts(): RtClientOptions {
  return { sockPath: process.env.RT_SOCK_PATH };
}

const HERDR_UNAVAILABLE = 'herdr unavailable';

function parseIntParam(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export const panes = new Hono()
  // herdr absent is a state the UI hides behind, not an error it shows.
  .get('/api/panes', async c => {
    if (fixturesEnabled()) return c.json({ available: true, panes: fixturePanes() }, 200);
    const res = await paneList(rtOpts());
    if (!res.ok) {
      if (res.error?.startsWith(HERDR_UNAVAILABLE)) return c.json({ available: false, panes: [] }, 200);
      return c.json({ error: res.error }, 502);
    }
    return c.json({ available: true, panes: res.data?.panes ?? [] }, 200);
  })
  .get('/api/panes/accounts', async c => {
    if (fixturesEnabled()) return c.json({ accounts: fixtureAccounts() }, 200);
    const res = await paneAccounts(rtOpts());
    if (!res.ok) return c.json({ error: res.error }, 502);
    return c.json(res.data, 200);
  })
  .get('/api/panes/directories', async c => {
    const q = c.req.query('q');
    if (fixturesEnabled()) return c.json({ directories: fixtureDirectories(q) }, 200);
    const res = await paneDirectories(q ? { q } : {}, rtOpts());
    if (!res.ok) return c.json({ error: res.error }, 502);
    return c.json(res.data, 200);
  })
  .get('/api/panes/:id/peek', async c => {
    const paneId = c.req.param('id');
    const lines = parseIntParam(c.req.query('lines'));
    if (fixturesEnabled()) return c.json({ paneId, lines: fixturePeek(paneId) }, 200);
    // Hono hands `:id` already decoded, so `w1:p1` arrives as itself.
    const res = await panePeek(lines === undefined ? { paneId } : { paneId, lines }, rtOpts());
    if (!res.ok) return c.json({ error: res.error }, 502);
    return c.json(res.data, 200);
  })
  .post('/api/panes', async c => {
    let raw: Record<string, unknown>;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Malformed JSON in request body' }, 400);
    }
    const str = (k: string) => (typeof raw?.[k] === 'string' && (raw[k] as string).length > 0 ? (raw[k] as string) : undefined);
    const cwd = str('cwd');
    if (!cwd || !cwd.startsWith('/')) return c.json({ error: 'cwd must be an absolute path' }, 400);
    const args = { cwd, account: str('account'), model: str('model'), effort: str('effort'), prompt: str('prompt'), workspace: str('workspace') };
    if (fixturesEnabled()) return c.json(fixtureSpawn(cwd), 200);
    const res = await paneSpawn(args, rtOpts());
    if (!res.ok) {
      const status = res.error?.startsWith('unknown cswap account') || res.error?.startsWith('cwd must be') ? 400 : 502;
      return c.json({ error: res.error }, status);
    }
    return c.json(res.data, 200);
  });
```

The test expects `paneSpawn` called with `undefined` for absent fields; `toHaveBeenCalledWith` treats `{ cwd, account: undefined }` as equal to `{ cwd }`, so either shape passes. Mount in `src/server/app.ts`: `import { panes } from './panes';` and `.route('/', panes)` between `chat` and `health`.

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run src/server`
Expected: all pass, including `app.test.ts`'s "importable without the Bun global".

- [ ] **Step 5: Commit**

```bash
git add src/server/panes.ts src/server/panes.test.ts src/server/app.ts src/server/chat.test.ts
git commit -m "server: /api/panes routes over rt-client's pane wrappers"
```

---

### Task 4: `POST /api/chat/rooms` and `POST /api/chat/invite`

**Files:**
- Modify: `src/server/chat.ts`
- Test: `src/server/chat.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/chat/rooms` `{ room, seed?, wakeOn? }` → `{ room, seedId? }`; 400 on a name outside `^[a-z0-9._-]+$`.
  - `POST /api/chat/invite` `{ room, panes: [{ paneId, note? }] }` → `{ results: InviteResult[] }`, sequential, 200 even when some are refused; 400 on an empty list or bad room.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/chat.test.ts`:

```ts
test('POST /api/chat/rooms joins as the human (creating the room), posts the seed, returns its id', async () => {
  vi.mocked(rt.chatJoin).mockResolvedValueOnce({ ok: true, data: { handle: 'matt', memberCount: 1, unread: 0 } });
  vi.mocked(rt.chatPost).mockResolvedValueOnce({ ok: true, data: { id: 42, recipients: [] } });
  const res = await app.request('/api/chat/rooms', { method: 'POST', body: JSON.stringify({ room: 'codegen-split', seed: 'Goal: halve the bundle', wakeOn: 'all' }) });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ room: 'codegen-split', seedId: 42 });
  expect(rt.chatJoin).toHaveBeenCalledWith({ room: 'codegen-split', handle: 'matt', wakeOn: 'all' }, expect.anything());
  expect(rt.chatPost).toHaveBeenCalledWith({ room: 'codegen-split', handle: 'matt', body: 'Goal: halve the bundle' }, expect.anything());
  expect(vi.mocked(rt.chatJoin).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(rt.chatPost).mock.invocationCallOrder[0]);
});

test('POST /api/chat/rooms without a seed only joins; a bad name is 400; a failed seed is 502 after the room exists', async () => {
  vi.mocked(rt.chatJoin).mockResolvedValueOnce({ ok: true, data: { handle: 'matt', memberCount: 1, unread: 0 } });
  const bare = await app.request('/api/chat/rooms', { method: 'POST', body: JSON.stringify({ room: 'quiet' }) });
  expect(await bare.json()).toEqual({ room: 'quiet' });
  expect(rt.chatPost).not.toHaveBeenCalled();
  expect((await app.request('/api/chat/rooms', { method: 'POST', body: JSON.stringify({ room: 'Bad Room' }) })).status).toBe(400);
  vi.mocked(rt.chatJoin).mockResolvedValueOnce({ ok: true, data: { handle: 'matt', memberCount: 1, unread: 0 } });
  vi.mocked(rt.chatPost).mockResolvedValueOnce({ ok: false, error: 'post refused' });
  const failed = await app.request('/api/chat/rooms', { method: 'POST', body: JSON.stringify({ room: 'x', seed: 's' }) });
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ error: 'post refused', room: 'x' });
});

test('POST /api/chat/invite invites each pane in order with the human as from, and returns every result', async () => {
  vi.mocked(rt.chatInvite)
    .mockResolvedValueOnce({ ok: true, data: { paneId: 'w1:p1', delivered: 'accepted' } })
    .mockResolvedValueOnce({ ok: true, data: { paneId: 'w1:p2', delivered: 'refused', reason: 'at a prompt' } });
  const res = await app.request('/api/chat/invite', { method: 'POST', body: JSON.stringify({ room: 'build', panes: [{ paneId: 'w1:p1', note: 'vite' }, { paneId: 'w1:p2' }] }) });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ results: [{ paneId: 'w1:p1', delivered: 'accepted' }, { paneId: 'w1:p2', delivered: 'refused', reason: 'at a prompt' }] });
  expect(vi.mocked(rt.chatInvite).mock.calls[0]![0]).toEqual({ paneId: 'w1:p1', room: 'build', note: 'vite', from: 'matt' });
  expect(vi.mocked(rt.chatInvite).mock.calls[1]![0]).toEqual({ paneId: 'w1:p2', room: 'build', from: 'matt' });
});

test('POST /api/chat/invite turns an rt failure for one pane into a refused result rather than failing the batch', async () => {
  vi.mocked(rt.chatInvite)
    .mockResolvedValueOnce({ ok: false, error: 'herdr unavailable: gone' })
    .mockResolvedValueOnce({ ok: true, data: { paneId: 'w1:p2', delivered: 'queued' } });
  const res = await app.request('/api/chat/invite', { method: 'POST', body: JSON.stringify({ room: 'build', panes: [{ paneId: 'w1:p1' }, { paneId: 'w1:p2' }] }) });
  expect(await res.json()).toEqual({ results: [{ paneId: 'w1:p1', delivered: 'refused', reason: 'herdr unavailable: gone' }, { paneId: 'w1:p2', delivered: 'queued' }] });
  expect((await app.request('/api/chat/invite', { method: 'POST', body: JSON.stringify({ room: 'build', panes: [] }) })).status).toBe(400);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/server/chat.test.ts`
Expected: the four new tests FAIL with 404.

- [ ] **Step 3: Add the routes**

In `src/server/chat.ts`, add `chatInvite` and `type InviteResult` to the rt-client import, and after the `/api/chat/dm` route:

```ts
  // Join-creates, so "create a room" is the human joining it; the seed is
  // the first post. A room whose seed fails still exists, so the error
  // carries the room name and the client keeps the draft.
  .post('/api/chat/rooms', async c => {
    let raw: { room?: unknown; seed?: unknown; wakeOn?: unknown };
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Malformed JSON in request body' }, 400);
    }
    const room = typeof raw?.room === 'string' ? raw.room : '';
    if (!ROOM_NAME.test(room)) return c.json({ error: 'room must match ^[a-z0-9._-]+$' }, 400);
    const seed = typeof raw?.seed === 'string' && raw.seed.trim() ? raw.seed : undefined;
    const wakeOn = raw?.wakeOn === 'all' || raw?.wakeOn === 'mention' || raw?.wakeOn === 'none' ? raw.wakeOn : undefined;
    const handle = humanHandle(c);
    const joinRes = await chatJoin(wakeOn ? { room, handle, wakeOn } : { room, handle }, rtOpts());
    if (!joinRes.ok) return c.json({ error: joinRes.error }, 502);
    if (!seed) return c.json({ room }, 200);
    const postRes = await chatPost({ room, handle, body: seed }, rtOpts());
    if (!postRes.ok) return c.json({ error: postRes.error, room }, 502);
    return c.json({ room, seedId: postRes.data?.id }, 200);
  })
  // Sequential on purpose: each invite types into a live terminal.
  .post('/api/chat/invite', async c => {
    let raw: { room?: unknown; panes?: unknown };
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Malformed JSON in request body' }, 400);
    }
    const room = typeof raw?.room === 'string' ? raw.room : '';
    if (!ROOM_NAME.test(room)) return c.json({ error: 'room must match ^[a-z0-9._-]+$' }, 400);
    const panes = Array.isArray(raw?.panes)
      ? raw.panes.flatMap((p): { paneId: string; note?: string }[] =>
          p && typeof p === 'object' && typeof (p as { paneId?: unknown }).paneId === 'string'
            ? [{ paneId: (p as { paneId: string }).paneId, ...(typeof (p as { note?: unknown }).note === 'string' && (p as { note: string }).note.trim() ? { note: (p as { note: string }).note } : {}) }]
            : []
        )
      : [];
    if (panes.length === 0) return c.json({ error: 'panes must name at least one pane' }, 400);
    const from = humanHandle(c);
    const results: InviteResult[] = [];
    for (const p of panes) {
      const res = await chatInvite({ paneId: p.paneId, room, from, ...(p.note ? { note: p.note } : {}) }, rtOpts());
      results.push(res.ok && res.data ? res.data : { paneId: p.paneId, delivered: 'refused', reason: res.error ?? 'invite failed' });
    }
    return c.json({ results }, 200);
  });
```

with `const ROOM_NAME = /^[a-z0-9._-]+$/;` near the top of the file (rt's `isValidChatName` charset). Add the four routes to the API table in `ARCHITECTURE.md`.

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run src/server`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/chat.ts src/server/chat.test.ts ARCHITECTURE.md
git commit -m "server: POST /api/chat/rooms creates and seeds; POST /api/chat/invite types into panes"
```

---

### Task 5: members refresh on `chat/<room>/msg`

**Files:**
- Modify: `src/app/App.tsx:247-284` (`useRoomMembers`)
- Test: `src/app/App.test.tsx`

**Interfaces:**
- `useRoomMembers(room, seed)` keeps its signature; it now also refetches `/api/chat/who/<room>` whenever a frame with `topic === \`chat/${room}/msg\`` arrives on `/ws`.

- [ ] **Step 1: Write the failing test**

First, in `src/ui/test-utils.tsx`, add `export` to the `FakeWebSocket` class (today only `installFakeWebSocket`/`restoreWebSocket` are exported). Then append to `src/app/App.test.tsx`, adding `FakeWebSocket` to its `@ui/test-utils` import and `userEvent` from `@testing-library/user-event` (Task 8 needs it too):

```tsx
test('a chat/<room>/msg frame refetches the open room\'s members', async () => {
  installFetchMock();
  fetchMock.mockImplementation(async (url: string) =>
    new Response(JSON.stringify(String(url).startsWith('/api/chat/who/') ? { members: [{ room: 'build', handle: 'fred', joinedAt: 1, lastReadId: 0, wakeOn: 'mention', status: 'live' }] } : {}))
  );
  window.history.replaceState(null, '', '/r/build');
  await act(async () => {
    renderWithProviders(<App initialState={{ ...twoRooms, members: [] }} />);
  });
  const before = fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/chat/who/build')).length;
  await act(async () => {
    for (const socket of FakeWebSocket.instances) socket.onmessage?.({ data: JSON.stringify({ topic: 'chat/build/msg', payload: { id: 7 } }) });
  });
  const after = fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/chat/who/build')).length;
  expect(after).toBeGreaterThan(before);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/app/App.test.tsx -t "refetches"`
Expected: FAIL (`after` equals `before`).

- [ ] **Step 3: Refactor the hook**

In `src/app/App.tsx`, rewrite `useRoomMembers` so the fetch is a `useCallback` keyed on `room`, the room-change effect calls it (keeping the seed one-shot rule), and a second effect opens a socket for the exact topic, the same shape `Transcript.tsx:506-530` uses:

```ts
function useRoomMembers(room: string | undefined, seed: ChatMember[] | undefined): string[] {
  const [members, setMembers] = useState<ChatMember[]>(seed ?? []);
  const seedPending = useRef(seed !== undefined);
  const roomRef = useRef(room);
  roomRef.current = room;

  const fetchMembers = useCallback(() => {
    if (!room) return;
    fetch(`/api/chat/who/${room}`)
      .then(res => res.json())
      .then((data: { members?: ChatMember[] }) => {
        if (roomRef.current === room) setMembers(data.members ?? []);
      })
      .catch(() => {});
  }, [room]);

  useEffect(() => {
    if (!room) {
      if (!seedPending.current) setMembers([]);
      return;
    }
    if (seedPending.current) {
      seedPending.current = false;
      return;
    }
    setMembers([]);
    fetchMembers();
  }, [room, fetchMembers]);

  // A post is the one signal an arriving member makes: the join skill's
  // first line. The daemon emits no membership frame, so this is the hook.
  useEffect(() => {
    if (!room) return;
    const expectedTopic = `chat/${room}/msg`;
    const socket = new WebSocket(wsUrl());
    socket.onmessage = event => {
      let frame: { topic?: unknown } | undefined;
      try {
        frame = JSON.parse(String((event as { data: unknown }).data));
      } catch {
        return;
      }
      if (frame?.topic === expectedTopic) fetchMembers();
    };
    return () => socket.close();
  }, [room, fetchMembers]);

  return members.map(m => m.handle);
}
```

- [ ] **Step 4: Run the suite**

Run: `bunx vitest run src/app src/ui/Transcript.test.tsx`
Expected: pass. If a Transcript test that pushes a frame to `FakeWebSocket.instances.at(-1)` now hits the members socket instead, change that helper in `src/ui/test-utils.tsx` to fan the frame to every instance.

- [ ] **Step 5: Commit**

```bash
git add src/app/App.tsx src/app/App.test.tsx src/ui/test-utils.tsx
git commit -m "app: refetch the room's members on every chat/<room>/msg frame"
```

---

### Task 6: `PanePicker`

**Files:**
- Modify: `src/ui/icons/Icons.ts` (add `UserPlus` import and `userPlus` entry)
- Create: `src/ui/PanePicker/types.ts`, `src/ui/PanePicker/PanePickerProvider.tsx`, `src/ui/PanePicker/PanePickerModal.tsx`, `src/ui/PanePicker/PaneRow.tsx`, `src/ui/PanePicker/NewPaneForm.tsx`, `src/ui/PanePicker/index.ts`
- Test: `src/ui/PanePicker/PanePicker.test.tsx`, `src/ui/icons/Icons.test.ts` (unchanged, guards the new icon)

**Interfaces:**
- Produces:

```ts
// src/ui/PanePicker/types.ts
export type { AgentStatus, ChatPane, InviteResult, PaneAccount, PaneDirectory } from '@mattstack/rt-client';
export interface PickPanesOptions {
  context?: string;
  multiple?: boolean;                            // default true
  disable?: (pane: ChatPane) => string | null;
  preselected?: string[];
  allowCreate?: boolean;                         // default false
}
export type PickPanes = (opts?: PickPanesOptions) => Promise<ChatPane[] | null>;

// src/ui/PanePicker/index.ts
export { PanePickerProvider, usePanePicker } from './PanePickerProvider';
export { PaneRow } from './PaneRow';
export type { PickPanes, PickPanesOptions } from './types';
```

  `PanePickerProvider` mounts one modal host; `usePanePicker()` returns `PickPanes`. `PaneRow` is exported because `NewRoomModal` (Task 7) reuses its top two lines for the picked list.
- Consumes: `GET /api/panes`, `GET /api/panes/:id/peek?lines=8`, `GET /api/panes/accounts`, `GET /api/panes/directories?q=`, `POST /api/panes`.

- [ ] **Step 1: The icon**

In `src/ui/icons/Icons.ts`, add `UserPlus` to the lucide import list and `userPlus: /* @__PURE__ */ lucideWrapperFn(UserPlus),` to `MiscIcons` beside `users`. Run `bunx vitest run src/ui/icons` (the registry guard passes).

- [ ] **Step 2: Write the failing tests**

Create `src/ui/PanePicker/PanePicker.test.tsx`:

```tsx
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test } from 'vitest';

import { renderWithProviders } from '@ui/storybook/test-utils';
import { fetchMock, installFetchMock } from '@ui/test-utils';
import { PanePickerProvider, usePanePicker, type PickPanesOptions } from './index';
import type { ChatPane } from './types';

const PANES: ChatPane[] = [
  { paneId: 'w1:p1', workspace: 'repo-tools', title: 'fred', cwd: '/r/repo-tools', repo: 'repo-tools', branch: 'main', agentStatus: 'working', presence: { handle: 'fred', status: 'live', rooms: ['repo-tools'] } },
  { paneId: 'w1:p2', workspace: 'chat', title: 'meg', cwd: '/r/chat', repo: 'chat', branch: 'main', agentStatus: 'idle', presence: { handle: 'meg', status: 'live', rooms: ['build'] } },
  { paneId: 'w1:p3', workspace: 'gitq', title: 'june', cwd: '/r/gitq', repo: 'gitq', branch: 'main', agentStatus: 'blocked', presence: { handle: 'june', status: 'idle', rooms: [] } },
  { paneId: 'w1:p4', workspace: 'acme', title: 'Evaluate codegen', cwd: '/r/acme', repo: 'acme', branch: 'main', agentStatus: 'idle' },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function route(handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url).split('?')[0]!;
    const key = `${init?.method ?? 'GET'} ${path}`;
    const handler = handlers[key] ?? handlers[`${init?.method ?? 'GET'} ${path.replace(/\/w\d:p\d\/peek$/, '/:id/peek')}`];
    if (!handler) return json({}, 404);
    return handler(init);
  });
}

function Harness({ opts, onDone }: { opts?: PickPanesOptions; onDone: (r: ChatPane[] | null) => void }) {
  const pick = usePanePicker();
  return (
    <button type="button" onClick={() => void pick(opts).then(onDone)}>
      open
    </button>
  );
}

function mount(opts?: PickPanesOptions) {
  const results: Array<ChatPane[] | null> = [];
  renderWithProviders(
    <PanePickerProvider>
      <Harness opts={opts} onDone={r => results.push(r)} />
    </PanePickerProvider>
  );
  return results;
}

beforeEach(() => {
  installFetchMock();
  route({ 'GET /api/panes': () => json({ available: true, panes: PANES }) });
});

test('lists claude panes sorted listening, idle, deaf, not signed in, with handle or not signed in', async () => {
  mount();
  await userEvent.click(screen.getByText('open'));
  const rows = await screen.findAllByTestId(/^pane-row-/);
  expect(rows.map(r => r.getAttribute('data-testid'))).toEqual(['pane-row-w1:p1', 'pane-row-w1:p2', 'pane-row-w1:p3', 'pane-row-w1:p4']);
  expect(within(rows[0]!).getByText('fred')).toBeInTheDocument();
  expect(within(rows[3]!).getByText('not signed in')).toBeInTheDocument();
  expect(within(rows[3]!).getByText('…/acme')).toBeInTheDocument();
});

test('the filter matches handle, workspace, title, repo and path', async () => {
  mount();
  await userEvent.click(screen.getByText('open'));
  await screen.findAllByTestId(/^pane-row-/);
  await userEvent.type(screen.getByTestId('pane-filter'), 'codegen');
  expect(screen.getAllByTestId(/^pane-row-/)).toHaveLength(1);
  await userEvent.clear(screen.getByTestId('pane-filter'));
  await userEvent.type(screen.getByTestId('pane-filter'), '/r/gitq');
  expect(screen.getAllByTestId(/^pane-row-/).map(r => r.getAttribute('data-testid'))).toEqual(['pane-row-w1:p3']);
});

test("the caller's disable reason renders inline and the row cannot be selected", async () => {
  const results = mount({ disable: p => (p.presence?.rooms.includes('build') ? 'in #build' : null) });
  await userEvent.click(screen.getByText('open'));
  const meg = await screen.findByTestId('pane-row-w1:p2');
  expect(within(meg).getByText('in #build')).toBeInTheDocument();
  await userEvent.click(within(meg).getByTestId('pane-check-w1:p2'));
  await userEvent.click(screen.getByTestId('pane-use'));
  expect(results).toEqual([[]]);
});

test('the eye fetches the peek for that row only, once opened', async () => {
  route({
    'GET /api/panes': () => json({ available: true, panes: PANES }),
    'GET /api/panes/:id/peek': () => json({ paneId: 'w1:p4', lines: ['⏺ Read(x)', '❯ '] }),
  });
  mount();
  await userEvent.click(screen.getByText('open'));
  await screen.findByTestId('pane-row-w1:p4');
  expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/peek'))).toBe(false);
  await userEvent.click(screen.getByTestId('pane-peek-button-w1:p4'));
  expect(await screen.findByTestId('pane-peek-w1:p4')).toHaveTextContent('Read(x)');
  expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/peek'))).toHaveLength(1);
});

test('resolves with the picked rows verbatim; cancel resolves null', async () => {
  const results = mount({ context: 'to invite to #build' });
  await userEvent.click(screen.getByText('open'));
  expect(await screen.findByText('to invite to #build')).toBeInTheDocument();
  await userEvent.click(screen.getByTestId('pane-check-w1:p1'));
  await userEvent.click(screen.getByTestId('pane-check-w1:p4'));
  await userEvent.click(screen.getByTestId('pane-use'));
  expect(results).toEqual([[PANES[0], PANES[3]]]);
  await userEvent.click(screen.getByText('open'));
  await screen.findByTestId('pane-row-w1:p1');
  await userEvent.click(screen.getByTestId('pane-cancel'));
  expect(results[1]).toBeNull();
});

test('multiple:false keeps one selection', async () => {
  const results = mount({ multiple: false });
  await userEvent.click(screen.getByText('open'));
  await userEvent.click(await screen.findByTestId('pane-check-w1:p1'));
  await userEvent.click(screen.getByTestId('pane-check-w1:p4'));
  await userEvent.click(screen.getByTestId('pane-use'));
  expect(results).toEqual([[PANES[3]]]);
});

test('new pane is hidden without allowCreate and present with it; the form posts and lists the pane as starting until ready', async () => {
  let release: (r: Response) => void = () => {};
  route({
    'GET /api/panes': () => json({ available: true, panes: PANES }),
    'GET /api/panes/accounts': () => json({ accounts: [{ slot: 1, email: 'a@b.c', alias: 'Acme', headroom: '5h 0%' }] }),
    'GET /api/panes/directories': () => json({ directories: [{ path: '/r/acme-wt', repo: 'acme', branch: 'perf' }] }),
    'POST /api/panes': () => new Promise<Response>(r => (release = r)),
  });
  mount();
  await userEvent.click(screen.getByText('open'));
  await screen.findByTestId('pane-row-w1:p1');
  expect(screen.queryByTestId('pane-new')).toBeNull();
  await userEvent.click(screen.getByTestId('pane-cancel'));

  const results = mount({ allowCreate: true });
  await userEvent.click(screen.getAllByText('open')[1]!);
  await userEvent.click(await screen.findByTestId('pane-new'));
  await userEvent.type(screen.getByLabelText('Directory'), '/r/acme-wt');
  await userEvent.click(screen.getByTestId('pane-start'));
  expect(await screen.findByText(/starting/)).toBeInTheDocument();
  const body = JSON.parse(String(fetchMock.mock.calls.find(([, i]) => (i as RequestInit)?.method === 'POST')![1]!.body));
  expect(body).toMatchObject({ cwd: '/r/acme-wt', account: 'Acme' });
  await act(async () => {
    release(json({ pane: { paneId: 'w9:p1', workspace: 'chat', cwd: '/r/acme-wt', agentStatus: 'idle' }, ready: true }));
  });
  const row = await screen.findByTestId('pane-row-w9:p1');
  expect(within(row).getByTestId('pane-check-w9:p1')).toHaveAttribute('aria-checked', 'true');
  await userEvent.click(screen.getByTestId('pane-use'));
  expect(results[0]).toEqual([{ paneId: 'w9:p1', workspace: 'chat', cwd: '/r/acme-wt', agentStatus: 'idle' }]);
});

test('a ready:false spawn keeps the row, unselectable, with its state', async () => {
  route({
    'GET /api/panes': () => json({ available: true, panes: [] }),
    'GET /api/panes/accounts': () => json({ accounts: [] }),
    'GET /api/panes/directories': () => json({ directories: [] }),
    'POST /api/panes': () => json({ pane: { paneId: 'w9:p2', workspace: 'chat', cwd: '/r/x', agentStatus: 'unknown' }, ready: false }),
  });
  mount({ allowCreate: true });
  await userEvent.click(screen.getByText('open'));
  await userEvent.click(await screen.findByTestId('pane-new'));
  expect(screen.queryByLabelText('Account')).toBeNull();
  await userEvent.type(screen.getByLabelText('Directory'), '/r/x');
  await userEvent.click(screen.getByTestId('pane-start'));
  const row = await screen.findByTestId('pane-row-w9:p2');
  expect(within(row).getByText(/never reached idle/)).toBeInTheDocument();
  expect(within(row).getByTestId('pane-check-w9:p2')).toHaveAttribute('aria-disabled', 'true');
});

test('herdr unavailable shows a notice and only cancel', async () => {
  route({ 'GET /api/panes': () => json({ available: false, panes: [] }) });
  const results = mount();
  await userEvent.click(screen.getByText('open'));
  expect(await screen.findByText(/herdr is not running/)).toBeInTheDocument();
  expect(screen.queryByTestId('pane-use')).toBeNull();
  await userEvent.click(screen.getByTestId('pane-cancel'));
  expect(results).toEqual([null]);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bunx vitest run src/ui/PanePicker`
Expected: FAIL, module not found.

- [ ] **Step 4: Write the types and the provider**

`src/ui/PanePicker/types.ts` exactly as in Interfaces. `src/ui/PanePicker/PanePickerProvider.tsx`:

```tsx
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

import { PanePickerModal } from './PanePickerModal';
import type { ChatPane, PickPanes, PickPanesOptions } from './types';

const PickContext = createContext<PickPanes | null>(null);

interface PendingPick {
  opts: PickPanesOptions;
  resolve: (r: ChatPane[] | null) => void;
}

/** Hosts the one picker modal, inside the app's providers, so any caller
    below can `usePanePicker()` and await a result. */
export function PanePickerProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingPick | null>(null);
  const pick = useCallback<PickPanes>(
    opts =>
      new Promise(resolve => {
        setPending(prev => {
          prev?.resolve(null);
          return { opts: opts ?? {}, resolve };
        });
      }),
    []
  );
  return (
    <PickContext.Provider value={pick}>
      {children}
      {pending && (
        <PanePickerModal
          opts={pending.opts}
          onDone={result => {
            pending.resolve(result);
            setPending(null);
          }}
        />
      )}
    </PickContext.Provider>
  );
}

export function usePanePicker(): PickPanes {
  const pick = useContext(PickContext);
  if (!pick) throw new Error('usePanePicker needs a PanePickerProvider above it');
  return pick;
}
```

- [ ] **Step 5: Write `PaneRow`**

`src/ui/PanePicker/PaneRow.tsx`. Anatomy from the artboard: a 16px checkbox (`aria-checked`, `aria-disabled`, `data-testid="pane-check-<id>"`), the 8px dot (colour from `DOT_COLOR[presence.status]`, hollow when there is no presence), the handle or `not signed in`, `·`, the workspace plus ` · title` when the title differs from the handle, the right-hand reason or state, a 22px eye button (`data-testid="pane-peek-button-<id>"`), a second line `repo · branch` with `Tag`s for rooms, the `headTruncatePath(cwd)` line, an optional `note` slot, and the peek block (`data-testid="pane-peek-<id>"`) when open.

```tsx
import type { ReactNode } from 'react';
import { Box, Group, Stack, Text, UnstyledButton } from '@mantine/core';

import { Icon } from '@ui/icons';
import { DOT_COLOR, headTruncatePath, Tag } from '../presence-bits';
import type { AgentStatus, ChatPane } from './types';

const MUTED = 'var(--tk-muted-text)';
const BORDER = 'var(--tk-border)';
const BORDER_SOFT = 'var(--tk-border-soft)';
const ACCENT_TEXT = 'var(--mantine-color-accent-text)';
const ACCENT_WASH = `color-mix(in srgb, ${ACCENT_TEXT} var(--tk-wash), transparent)`;
const ACCENT_DEEP = 'light-dark(var(--mantine-color-accent-7), var(--mantine-color-accent-text))';
const ACCENT_ON = 'light-dark(var(--mantine-color-white), var(--tk-bg))';

const STATE_COLOR: Record<AgentStatus, string> = {
  working: 'var(--mantine-color-warn-text)',
  blocked: 'var(--mantine-color-bad-text)',
  idle: MUTED,
  done: MUTED,
  unknown: MUTED,
};

export function agentStateLabel(status: AgentStatus): string {
  if (status === 'working') return 'working · queues until its turn ends';
  if (status === 'blocked') return 'at a prompt · answer it first';
  return status;
}

export interface PaneRowProps {
  pane: ChatPane;
  /** Absent: no checkbox (the picked list in New room). */
  selected?: boolean;
  disabledReason?: string | null;
  onToggle?: () => void;
  onPeek?: () => void;
  peek?: string[] | 'loading';
  /** Rendered under the path: the note input, or the remove control. */
  extra?: ReactNode;
  trailing?: ReactNode;
}

export function PaneRow({ pane, selected, disabledReason, onToggle, onPeek, peek, extra, trailing }: PaneRowProps) {
  const disabled = !!disabledReason;
  const handle = pane.presence?.handle;
  const sub = handle && pane.title === handle ? pane.workspace : `${pane.workspace}${pane.title ? ` · ${pane.title}` : ''}`;
  const where = [pane.repo, pane.branch].filter(Boolean).join(' · ');
  return (
    <Box
      data-testid={`pane-row-${pane.paneId}`}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--mantine-spacing-md)',
        padding: '8.4px var(--mantine-spacing-md)',
        borderRadius: 'var(--mantine-radius-md)',
        minWidth: 0,
        background: selected ? ACCENT_WASH : undefined,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {onToggle && (
        <UnstyledButton
          role="checkbox"
          aria-checked={!!selected}
          aria-disabled={disabled}
          aria-label={`select ${handle ?? pane.paneId}`}
          data-testid={`pane-check-${pane.paneId}`}
          onClick={() => {
            if (!disabled) onToggle();
          }}
          style={{
            width: 16,
            height: 16,
            marginTop: 2,
            flex: 'none',
            borderRadius: 4,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: `1px solid ${disabled ? MUTED : selected ? ACCENT_DEEP : BORDER}`,
            background: disabled ? 'var(--ui-bg-4)' : selected ? ACCENT_DEEP : 'var(--tk-bg)',
            color: ACCENT_ON,
            cursor: disabled ? 'default' : 'pointer',
          }}
        >
          {selected && !disabled && <Icon name="check" size={11} />}
        </UnstyledButton>
      )}
      <Stack gap={1} style={{ flex: 1, minWidth: 0 }}>
        <Group gap="xs" wrap="nowrap">
          <Box
            component="span"
            data-testid={`pane-dot-${pane.paneId}`}
            style={{
              width: 8,
              height: 8,
              marginTop: 5,
              flex: 'none',
              borderRadius: '50%',
              background: pane.presence ? (DOT_COLOR[pane.presence.status as 'live' | 'idle' | 'deaf'] ?? 'transparent') : 'transparent',
              border: pane.presence ? undefined : `1px solid ${BORDER}`,
            }}
          />
          {handle ? (
            <Text component="span" size="sm" fw={600}>
              {handle}
            </Text>
          ) : (
            <Text component="span" size="sm" style={{ color: MUTED }}>
              not signed in
            </Text>
          )}
          <Text component="span" size="xs" style={{ color: MUTED }}>
            ·
          </Text>
          <Text component="span" size="xs" truncate style={{ color: MUTED, flex: 1 }}>
            {sub}
          </Text>
          {disabledReason ? (
            <Text component="span" size="xs" style={{ color: STATE_COLOR.blocked, flex: 'none' }}>
              {disabledReason}
            </Text>
          ) : (
            <Text component="span" size="xs" style={{ color: STATE_COLOR[pane.agentStatus], fontWeight: 500, flex: 'none' }}>
              {agentStateLabel(pane.agentStatus)}
            </Text>
          )}
          {trailing}
          {onPeek && (
            <UnstyledButton
              aria-label="Peek at pane"
              data-testid={`pane-peek-button-${pane.paneId}`}
              onClick={onPeek}
              style={{ width: 22, height: 22, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--mantine-radius-md)', color: MUTED }}
            >
              <Icon name="eye" size={13} />
            </UnstyledButton>
          )}
        </Group>
        <Group gap={6} wrap="nowrap">
          <Text component="span" size="xs" style={{ color: MUTED }}>
            {where}
          </Text>
          {pane.presence?.rooms.map(room => <Tag key={room} handle={handle ?? pane.paneId} room={room} />)}
        </Group>
        {pane.cwd && (
          <Text component="span" size="xs" truncate style={{ color: MUTED }}>
            {headTruncatePath(pane.cwd)}
          </Text>
        )}
        {extra}
        {peek && (
          <Box
            component="pre"
            data-testid={`pane-peek-${pane.paneId}`}
            style={{
              margin: '4.8px 0 0',
              padding: '7.2px var(--mantine-spacing-md)',
              background: 'var(--tk-bg)',
              border: `1px solid ${BORDER}`,
              borderRadius: 4,
              fontFamily: 'inherit',
              fontSize: '11.2px',
              lineHeight: 1.5,
              whiteSpace: 'pre',
              overflowX: 'auto',
              color: MUTED,
            }}
          >
            {peek === 'loading' ? 'reading the pane…' : peek.join('\n')}
          </Box>
        )}
      </Stack>
      <Box component="span" style={{ display: 'none', borderTop: `1px solid ${BORDER_SOFT}` }} />
    </Box>
  );
}
```

Row separators: the list container draws `border-top: 1px solid var(--tk-border-soft)` between rows (`.pane + .pane`), so give the list's rows `[data-testid^="pane-row-"] + [data-testid^="pane-row-"] { border-top ... }` through an inline style on every row except the first (pass `first` from the list and set `borderTop` accordingly); drop the hidden trailing span above once that is in place.

- [ ] **Step 6: Write `NewPaneForm`**

`src/ui/PanePicker/NewPaneForm.tsx`: directory (a `TextInput` from `@ui/core`, `label="Directory"`, with suggestions fetched from `/api/panes/directories?q=` on each change, rendered as a list of 34px `.opt`-style buttons under the input that fill the field when clicked), account (`Select` from `@mantine/core`, `label="Account"`, options `${alias ?? email} · ${headroom}` with value `alias ?? email`, hidden when `/api/panes/accounts` answers empty, defaulting to the first account), model (`Select`, `label="Model"`, options `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, default `claude-fable-5`), effort (`Select`, `label="Effort"`, options blank, `low`, `medium`, `high`, `max`, default blank), workspace (`TextInput`, `label="Workspace"`, default `chat`), opening prompt (`Textarea`, `label="Opening prompt"`), a hint line showing the launch command it will run (`cswap run <account> --share-history -- claude --model <m> [--effort <e>]` or `claude ...` without an account), and a footer with `Back` (`data-testid="pane-back"`) and `Start pane` (`data-testid="pane-start"`, disabled until the directory starts with `/`). Props: `{ onBack: () => void; onStart: (args: { cwd; account?; model?; effort?; prompt?; workspace? }) => void }`. Fetch accounts once on mount.

- [ ] **Step 7: Write `PanePickerModal`**

`src/ui/PanePicker/PanePickerModal.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Box, Button, Group, Modal, Stack, Text } from '@mantine/core';

import { TextInput } from '@ui/core';
import { useIsMobile } from '@ui/hooks';
import { Icon } from '@ui/icons';
import { notifications } from '@ui/notifications';
import { NewPaneForm } from './NewPaneForm';
import { PaneRow } from './PaneRow';
import type { ChatPane, PickPanesOptions } from './types';

const ORDER: Record<string, number> = { live: 0, idle: 1, deaf: 2 };

export function sortPanes(panes: ChatPane[]): ChatPane[] {
  return panes
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (ORDER[a.p.presence?.status ?? ''] ?? 3) - (ORDER[b.p.presence?.status ?? ''] ?? 3) || a.i - b.i)
    .map(({ p }) => p);
}

export function matchesFilter(pane: ChatPane, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [pane.presence?.handle, pane.workspace, pane.title, pane.repo, pane.cwd, pane.paneId]
    .filter((v): v is string => typeof v === 'string')
    .some(v => v.toLowerCase().includes(needle));
}

interface Starting {
  key: string;
  cwd: string;
}

export function PanePickerModal({ opts, onDone }: { opts: PickPanesOptions; onDone: (r: ChatPane[] | null) => void }) {
  const multiple = opts.multiple ?? true;
  const [available, setAvailable] = useState<boolean | null>(null);
  const [panes, setPanes] = useState<ChatPane[]>([]);
  const [notReady, setNotReady] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState<Starting[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(opts.preselected ?? []));
  const [filter, setFilter] = useState('');
  const [peeks, setPeeks] = useState<Record<string, string[] | 'loading'>>({});
  const [view, setView] = useState<'list' | 'new'>('list');
  const mobile = useIsMobile();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/panes')
      .then(res => res.json())
      .then((data: { available?: boolean; panes?: ChatPane[] }) => {
        if (cancelled) return;
        setAvailable(data.available !== false);
        setPanes(sortPanes(data.panes ?? []));
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => panes.filter(p => matchesFilter(p, filter)), [panes, filter]);

  function reasonFor(pane: ChatPane): string | null {
    if (notReady.has(pane.paneId)) return 'never reached idle · peek to see why';
    return opts.disable?.(pane) ?? null;
  }

  function toggle(pane: ChatPane) {
    setSelected(prev => {
      const next = new Set(multiple ? prev : []);
      if (prev.has(pane.paneId)) next.delete(pane.paneId);
      else next.add(pane.paneId);
      return next;
    });
  }

  function peek(pane: ChatPane) {
    if (peeks[pane.paneId]) {
      setPeeks(prev => {
        const next = { ...prev };
        delete next[pane.paneId];
        return next;
      });
      return;
    }
    setPeeks(prev => ({ ...prev, [pane.paneId]: 'loading' }));
    // Pane ids never contain a slash; sent bare so the server's `:id` and the tests' URL match.
    fetch(`/api/panes/${pane.paneId}/peek?lines=8`)
      .then(res => res.json())
      .then((data: { lines?: string[] }) => setPeeks(prev => ({ ...prev, [pane.paneId]: data.lines ?? [] })))
      .catch(() => setPeeks(prev => ({ ...prev, [pane.paneId]: ['(could not read the pane)'] })));
  }

  function start(args: { cwd: string; account?: string; model?: string; effort?: string; prompt?: string; workspace?: string }) {
    const key = `starting-${Date.now()}`;
    setStarting(prev => [...prev, { key, cwd: args.cwd }]);
    setView('list');
    fetch('/api/panes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
      .then(async res => {
        if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'spawn failed');
        return (await res.json()) as { pane: ChatPane; ready: boolean };
      })
      .then(({ pane, ready }) => {
        setStarting(prev => prev.filter(s => s.key !== key));
        setPanes(prev => sortPanes([...prev.filter(p => p.paneId !== pane.paneId), pane]));
        if (ready) setSelected(prev => new Set(multiple ? [...prev, pane.paneId] : [pane.paneId]));
        else setNotReady(prev => new Set([...prev, pane.paneId]));
      })
      .catch((err: Error) => {
        setStarting(prev => prev.filter(s => s.key !== key));
        notifications.error(`Couldn't start the pane: ${err.message}`);
      });
  }

  const picked = panes.filter(p => selected.has(p.paneId) && !reasonFor(p));
  const title = (
    <Group gap="xs" wrap="nowrap">
      <Icon name="terminal" size={18} />
      <Text size="xl" fw={700}>
        {view === 'new' ? 'New pane' : 'Pick herdr panes'}
      </Text>
      {opts.context && view === 'list' && (
        <Text size="sm" style={{ color: 'var(--tk-muted-text)' }}>
          {opts.context}
        </Text>
      )}
    </Group>
  );

  return (
    <Modal opened onClose={() => onDone(null)} title={title} size={640} fullScreen={mobile} data-testid="pane-picker" closeButtonProps={{ 'aria-label': 'Close' }}>
      {view === 'new' ? (
        <NewPaneForm onBack={() => setView('list')} onStart={start} />
      ) : (
        <Stack gap="xs">
          {available === false ? (
            <Text size="sm">herdr is not running, so there are no panes to list.</Text>
          ) : (
            <>
              <TextInput size="xs" placeholder="filter by handle, workspace, title, repo, path" leftSection={<Icon name="search" size={13} />} value={filter} onChange={e => setFilter(e.currentTarget.value)} data-testid="pane-filter" aria-label="Filter panes" />
              <Group justify="space-between" wrap="nowrap">
                <Text size="xs" style={{ color: 'var(--tk-muted-text)' }}>
                  {panes.length} panes running Claude · sorted listening, idle, deaf, not signed in
                </Text>
                <Group gap="xs" wrap="nowrap">
                  <Text size="xs" style={{ color: 'var(--tk-muted-text)' }}>
                    {picked.length} selected
                  </Text>
                  {opts.allowCreate && (
                    <Button size="xs" variant="default" leftSection={<Icon name="plus" size={14} />} onClick={() => setView('new')} data-testid="pane-new">
                      new pane
                    </Button>
                  )}
                </Group>
              </Group>
              <Stack gap={0} style={{ border: '1px solid var(--tk-border)', borderRadius: 'var(--mantine-radius-md)', background: 'var(--tk-panel)', maxHeight: mobile ? undefined : 560, overflow: 'auto', padding: '2px 0' }}>
                {starting.map(s => (
                  <PaneRow key={s.key} pane={{ paneId: s.key, workspace: 'chat', cwd: s.cwd, agentStatus: 'unknown' }} disabledReason="starting claude · selectable when idle" onToggle={() => {}} />
                ))}
                {visible.map(pane => (
                  <PaneRow key={pane.paneId} pane={pane} selected={selected.has(pane.paneId)} disabledReason={reasonFor(pane)} onToggle={() => toggle(pane)} onPeek={() => peek(pane)} peek={peeks[pane.paneId]} />
                ))}
              </Stack>
            </>
          )}
          <Group justify="flex-end" gap="xs" style={{ borderTop: '1px solid var(--tk-border-soft)', paddingTop: 'var(--mantine-spacing-xs)' }}>
            <Text size="xs" style={{ color: 'var(--tk-muted-text)', flex: 1 }}>
              the eye peeks at a pane's last lines when a title is not enough
            </Text>
            <Button variant="default" size="sm" onClick={() => onDone(null)} data-testid="pane-cancel">
              Cancel
            </Button>
            {available !== false && (
              <Button size="sm" leftSection={<Icon name="check" size={14} />} onClick={() => onDone(picked)} data-testid="pane-use">
                Use {picked.length} {picked.length === 1 ? 'pane' : 'panes'}
              </Button>
            )}
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
```

Look up `Modal`'s `fullScreen`, `size`, `closeButtonProps` and `Button`'s `leftSection`/`variant` props in the Mantine docs before relying on them. On the phone, buttons take `size="md"` and the row's controls 44px (`mobile ? 44 : 22` for the eye, `mobile ? 24 : 16` for the checkbox).

- [ ] **Step 8: Run the tests**

Run: `bunx vitest run src/ui/PanePicker src/ui/icons`
Expected: pass. Then `bun run typecheck && bun run lint`.

- [ ] **Step 9: Commit**

```bash
git add src/ui/icons/Icons.ts src/ui/PanePicker
git commit -m "ui: PanePicker, a standalone picker over /api/panes with peek and spawn"
```

---

### Task 7: `NewRoomModal`

**Files:**
- Create: `src/ui/NewRoomModal.tsx`
- Test: `src/ui/NewRoomModal.test.tsx`

**Interfaces:**
- Produces:

```ts
export interface NewRoomModalProps {
  opened: boolean;
  onClose: () => void;
  /** After a successful create: the room, the invite results when any were sent, and the panes they were sent to (so the caller can name them). */
  onCreated: (room: string, results: InviteResult[], picked: ChatPane[]) => void;
  daemonReachable?: boolean;
}
```

  Uses `usePanePicker()` with `{ context: 'to invite to #<room>', allowCreate: true, disable }` where `disable` marks `agentStatus === 'blocked'` as `at a prompt · answer it first` and a pane whose `presence.rooms` contains the room as `in #<room>`.
- Consumes: `POST /api/chat/rooms`, `POST /api/chat/invite`, `PaneRow` (without a checkbox, with the note input and a remove control in `extra`/`trailing`).

- [ ] **Step 1: Write the failing tests**

Create `src/ui/NewRoomModal.test.tsx`:

```tsx
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import { renderWithProviders } from '@ui/storybook/test-utils';
import { fetchMock, installFetchMock } from '@ui/test-utils';
import { NewRoomModal } from './NewRoomModal';
import { PanePickerProvider } from './PanePicker';

const PANES = [
  { paneId: 'w1:p1', workspace: 'acme', title: 'Evaluate codegen', cwd: '/r/acme', repo: 'acme', branch: 'main', agentStatus: 'idle' },
  { paneId: 'w1:p2', workspace: 'chat', title: 'meg', cwd: '/r/chat', repo: 'chat', branch: 'main', agentStatus: 'idle', presence: { handle: 'meg', status: 'live', rooms: ['codegen-split'] } },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function mount(onCreated = vi.fn(), onClose = vi.fn()) {
  renderWithProviders(
    <PanePickerProvider>
      <NewRoomModal opened onClose={onClose} onCreated={onCreated} />
    </PanePickerProvider>
  );
  return { onCreated, onClose };
}

beforeEach(() => {
  installFetchMock();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url).split('?')[0];
    if (path === '/api/panes') return json({ available: true, panes: PANES });
    if (path === '/api/chat/rooms') return json({ room: JSON.parse(String(init?.body)).room, seedId: 9 });
    if (path === '/api/chat/invite') return json({ results: [{ paneId: 'w1:p1', delivered: 'accepted' }] });
    return json({});
  });
});

test('the name field enforces the room charset before anything is sent', async () => {
  mount();
  await userEvent.type(screen.getByLabelText('Room'), 'Bad Room');
  expect(screen.getByTestId('new-room-create')).toBeDisabled();
  expect(await screen.findByText('lowercase, digits, dashes')).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/chat/rooms')).toBe(false);
});

test('pick panes opens the picker with the room as context and disables panes already in it; picked rows get a note', async () => {
  mount();
  await userEvent.type(screen.getByLabelText('Room'), 'codegen-split');
  await userEvent.click(screen.getByTestId('new-room-pick'));
  expect(await screen.findByText('to invite to #codegen-split')).toBeInTheDocument();
  expect(within(screen.getByTestId('pane-row-w1:p2')).getByText('in #codegen-split')).toBeInTheDocument();
  await userEvent.click(screen.getByTestId('pane-check-w1:p1'));
  await userEvent.click(screen.getByTestId('pane-use'));
  const picked = await screen.findByTestId('picked-w1:p1');
  await userEvent.type(within(picked).getByLabelText('note for this pane'), 'you own vite');
  expect(screen.getByTestId('new-room-create')).toHaveTextContent('invite 1');
});

test('submit creates, seeds, then invites in order, and reports the room and results', async () => {
  const { onCreated } = mount();
  await userEvent.type(screen.getByLabelText('Room'), 'codegen-split');
  await userEvent.type(screen.getByLabelText('Seed'), 'Goal: halve the bundle');
  await userEvent.click(screen.getByTestId('new-room-pick'));
  await userEvent.click(await screen.findByTestId('pane-check-w1:p1'));
  await userEvent.click(screen.getByTestId('pane-use'));
  await userEvent.type(within(await screen.findByTestId('picked-w1:p1')).getByLabelText('note for this pane'), 'you own vite');
  await userEvent.click(screen.getByTestId('new-room-create'));
  await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('codegen-split', [{ paneId: 'w1:p1', delivered: 'accepted' }], [PANES[0]]));
  const calls = fetchMock.mock.calls.map(([u, i]) => [String(u), i as RequestInit | undefined] as const);
  const rooms = calls.findIndex(([u]) => u === '/api/chat/rooms');
  const invite = calls.findIndex(([u]) => u === '/api/chat/invite');
  expect(rooms).toBeGreaterThan(-1);
  expect(invite).toBeGreaterThan(rooms);
  expect(JSON.parse(String(calls[rooms]![1]!.body))).toEqual({ room: 'codegen-split', seed: 'Goal: halve the bundle', wakeOn: 'mention' });
  expect(JSON.parse(String(calls[invite]![1]!.body))).toEqual({ room: 'codegen-split', panes: [{ paneId: 'w1:p1', note: 'you own vite' }] });
});

test('create without inviting skips the invite route', async () => {
  const { onCreated } = mount();
  await userEvent.type(screen.getByLabelText('Room'), 'quiet');
  await userEvent.click(screen.getByTestId('new-room-create-only'));
  await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('quiet', [], []));
  expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/chat/invite')).toBe(false);
});

test('a failed create keeps the draft and reports the error', async () => {
  fetchMock.mockImplementation(async (url: string) =>
    String(url) === '/api/chat/rooms' ? json({ error: 'rt daemon unreachable' }, 502) : json({ available: true, panes: [] })
  );
  const { onCreated } = mount();
  await userEvent.type(screen.getByLabelText('Room'), 'x');
  await userEvent.type(screen.getByLabelText('Seed'), 'keep me');
  await userEvent.click(screen.getByTestId('new-room-create-only'));
  expect(await screen.findByText(/rt daemon unreachable/)).toBeInTheDocument();
  expect(screen.getByLabelText('Seed')).toHaveValue('keep me');
  expect(onCreated).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/ui/NewRoomModal.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the modal**

`src/ui/NewRoomModal.tsx`, built on `useForm` + `zodResolver` from `@ui/forms` (schema: `room` matching `/^[a-z0-9._-]+$/` with the message `lowercase, digits, dashes`, `seed` any string, `wakeOn` enum `mention | all`; `validateInputOnChange: true` so the charset error shows as you type), `FormContainer` with `plain` and `hideChrome`, `TextInput` (`label="Room"`, `leftSection` a muted `#`, the hint `lowercase, digits, dashes · the room exists once you post the seed`), `Textarea` (`label="Seed"`, `autosize`, `minRows={4}`, the two hints `posted as matt · every invitee is told to read it first` and `markdown subset · blank line between points`), a `Select` for `wakeOn` (`aria-label="Wakes"`, data `mention`/`all`, hint `all = a war room, nobody has to @here`), the Agents section (header `AGENTS · N to invite`, a `pick panes` button `data-testid="new-room-pick"` that calls `pickPanes({ context: \`to invite to #${room || '…'}\`, allowCreate: true, disable, preselected: picked.map(p => p.paneId) })` and replaces the picked list with the result when it is not `null`), one `PaneRow` per picked pane inside `data-testid={\`picked-${paneId}\`}` with `extra` = a `TextInput` (`aria-label="note for this pane"`, placeholder `note for this pane (optional)`) and `trailing` = a remove `UnstyledButton` (`aria-label="Remove"`, the `close` icon), and the footer: `Create without inviting` (`data-testid="new-room-create-only"`) and `Create #<room> · invite N` (`data-testid="new-room-create"`), both disabled while the form is invalid or a submit is in flight. Submit:

```ts
async function submit(invite: boolean) {
  setBusy(true);
  setError(undefined);
  try {
    const res = await fetch('/api/chat/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: values.room, seed: values.seed || undefined, wakeOn: values.wakeOn }) });
    if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'create failed');
    let results: InviteResult[] = [];
    if (invite && picked.length > 0) {
      const inv = await fetch('/api/chat/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: values.room, panes: picked.map(p => ({ paneId: p.paneId, ...(notes[p.paneId]?.trim() ? { note: notes[p.paneId] } : {}) })) }) });
      if (!inv.ok) throw new Error(((await inv.json()) as { error?: string }).error ?? 'invite failed');
      results = ((await inv.json()) as { results: InviteResult[] }).results;
    }
    onCreated(values.room, results, invite ? picked : []);
    form.reset();
    setPicked([]);
    setNotes({});
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  } finally {
    setBusy(false);
  }
}
```

The error renders as `<Text size="xs" c="bad">` under the footer (`hideChrome` means the form owns error display). The modal is a Mantine `Modal` (`size={680}`, `fullScreen` on `useIsMobile()`), title `New room` with the `hash` icon, `closeOnClickOutside`/`closeOnEscape` false while `busy`. `daemonReachable === false` disables both submit buttons with the hint `rt daemon unreachable · the draft is kept`.

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run src/ui/NewRoomModal.test.tsx && bun run typecheck && bun run lint`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui/NewRoomModal.tsx src/ui/NewRoomModal.test.tsx
git commit -m "ui: NewRoomModal creates, seeds and invites through the pane picker"
```

---

### Task 8: entry points, the notice line, and App wiring

**Files:**
- Modify: `src/ui/RoomRail.tsx` (props `daemonReachable?`, `onNewRoom?`; the 24px `+`)
- Modify: `src/ui/PageBar.tsx` (prop `onAddAgents?`; the `add agents` button before `mark read`)
- Modify: `src/ui/Transcript.tsx` (prop `notice?: ReactNode`, rendered as an edge row above `OlderEdge`)
- Modify: `src/app/App.tsx` (`usePanesAvailable`, `PanePickerProvider`, `NewRoomModal` state, `add agents` flow, the notice state)
- Test: `src/ui/RoomRail.test.tsx`, `src/ui/PageBar.test.tsx`, `src/ui/Transcript.test.tsx`, `src/app/App.test.tsx`

**Interfaces:**
- `RoomRailProps` gains `daemonReachable?: boolean` (default `true`) and `onNewRoom?: () => void`; the `+` renders only when `onNewRoom` is given, disabled when `daemonReachable` is false, `aria-label="New room"`, `data-testid="new-room-button"`.
- `PageBarProps` gains `onAddAgents?: () => void`; the button renders only when given, disabled when `reachable` is false, `aria-label` `Add agents to #<room>`, `data-testid="add-agents-button"`.
- `TranscriptProps` gains `notice?: ReactNode`; rendered in `data-testid="transcript-notice"` with the `.edge` values (`padding: 6px 0 4px`, 10.56px, muted) but `textAlign: left`.
- App: `usePanesAvailable()` polls `GET /api/panes` once on mount and every 30s, returns `boolean | undefined`; both entry points are passed only when it is `true`.

- [ ] **Step 1: Write the failing tests**

Append to `src/ui/RoomRail.test.tsx`:

```tsx
test('the + renders only with onNewRoom, disables with the daemon down, and fires', async () => {
  const onNewRoom = vi.fn();
  const rooms = [{ room: 'build', memberCount: 1, unread: 0, mentions: 0 }];
  const { rerender } = renderWithProviders(<RoomRail rooms={rooms} />);
  expect(screen.queryByTestId('new-room-button')).toBeNull();
  rerender(<RoomRail rooms={rooms} onNewRoom={onNewRoom} daemonReachable={false} />);
  expect(screen.getByTestId('new-room-button')).toBeDisabled();
  rerender(<RoomRail rooms={rooms} onNewRoom={onNewRoom} />);
  await userEvent.click(screen.getByRole('button', { name: 'New room' }));
  expect(onNewRoom).toHaveBeenCalled();
});
```

Append to `src/ui/PageBar.test.tsx` (mirror its existing render helper):

```tsx
test('add agents sits before mark read, only when wired, disabled while the daemon is down', async () => {
  const onAddAgents = vi.fn();
  const room = { room: 'build', memberCount: 2, unread: 3, mentions: 0 };
  const { rerender } = renderWithProviders(<PageBar room={room} buddies={[]} />);
  expect(screen.queryByTestId('add-agents-button')).toBeNull();
  rerender(<PageBar room={room} buddies={[]} onAddAgents={onAddAgents} reachable={false} />);
  expect(screen.getByTestId('add-agents-button')).toBeDisabled();
  rerender(<PageBar room={room} buddies={[]} onAddAgents={onAddAgents} onMarkRead={() => {}} />);
  const buttons = screen.getAllByRole('button').map(b => b.getAttribute('data-testid'));
  expect(buttons.indexOf('add-agents-button')).toBeLessThan(buttons.indexOf('mark-read-button'));
  await userEvent.click(screen.getByRole('button', { name: 'Add agents to #build' }));
  expect(onAddAgents).toHaveBeenCalled();
});
```

Append to `src/ui/Transcript.test.tsx` (the file has no local render helper; `OlderEdge` only renders with at least one message, so seed one):

```tsx
test('a notice renders at the edge, above the older-messages row, and without any messages at all', () => {
  const one = [{ id: 1, room: 'build', handle: 'meg', body: 'hi', mentions: [], postedAt: 1 }];
  const { unmount } = renderWithProviders(<Transcript room="build" messages={one} notice={<span>invited 2 · acme accepted</span>} />);
  const notice = screen.getByTestId('transcript-notice');
  expect(notice).toHaveTextContent('invited 2 · acme accepted');
  expect(notice.compareDocumentPosition(screen.getByTestId('transcript-edge')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  unmount();
  renderWithProviders(<Transcript room="quiet" messages={[]} notice={<span>invited 1</span>} />);
  expect(screen.getByTestId('transcript-notice')).toHaveTextContent('invited 1');
});
```

(Match the message object to the `ChatMessage` shape the file's other tests use; add `userEvent` to `RoomRail.test.tsx`'s and `PageBar.test.tsx`'s imports if absent.)

Append to `src/app/App.test.tsx`:

```tsx
test('the entry points hide while herdr is unavailable and show once /api/panes says available', async () => {
  installFetchMock();
  fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(String(url).startsWith('/api/panes') ? { available: false, panes: [] } : {})));
  window.history.replaceState(null, '', '/r/build');
  const { unmount } = renderWithProviders(<App initialState={twoRooms} />);
  await act(async () => {});
  expect(screen.queryByTestId('new-room-button')).toBeNull();
  expect(screen.queryByTestId('add-agents-button')).toBeNull();
  unmount();
  fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(String(url).startsWith('/api/panes') ? { available: true, panes: [] } : {})));
  renderWithProviders(<App initialState={twoRooms} />);
  expect(await screen.findByTestId('new-room-button')).toBeInTheDocument();
  expect(screen.getByTestId('add-agents-button')).toBeInTheDocument();
});

test('add agents invites the picked panes and shows the result line on the transcript edge', async () => {
  installFetchMock();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url).split('?')[0];
    if (path === '/api/panes') return new Response(JSON.stringify({ available: true, panes: [{ paneId: 'w1:p4', workspace: 'acme', title: 'Evaluate codegen', cwd: '/r/acme', agentStatus: 'idle' }] }));
    if (path === '/api/chat/invite' && init?.method === 'POST') return new Response(JSON.stringify({ results: [{ paneId: 'w1:p4', delivered: 'accepted' }] }));
    return new Response(JSON.stringify({}));
  });
  window.history.replaceState(null, '', '/r/build');
  renderWithProviders(<App initialState={{ ...twoRooms, messages: [{ id: 1, room: 'build', handle: 'meg', body: 'hi', mentions: [], postedAt: 1 }] }} />);
  await userEvent.click(await screen.findByTestId('add-agents-button'));
  await userEvent.click(await screen.findByTestId('pane-check-w1:p4'));
  await userEvent.click(screen.getByTestId('pane-use'));
  expect(await screen.findByTestId('transcript-notice')).toHaveTextContent('invited 1 · acme pane accepted');
});
```

(Adjust the seeded message's shape to the `ChatMessage` fields the file already uses.)

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/ui/RoomRail.test.tsx src/ui/PageBar.test.tsx src/ui/Transcript.test.tsx src/app/App.test.tsx`
Expected: the new tests FAIL.

- [ ] **Step 3: RoomRail and PageBar**

`RoomRail.tsx`: add the two props; in the header `Group`'s right side, wrap the count and a 24px `UnstyledButton` (`data-testid="new-room-button"`, `aria-label="New room"`, `disabled={!daemonReachable}`, `onClick={onNewRoom}`, `<Icon name="plus" size={14} />`, the `.aicon` treatment: 6px radius, muted colour, `bg4` on hover) in a `Group gap={2} wrap="nowrap"`.

`PageBar.tsx`: in `controls`, before the `mark read` button, when `onAddAgents`:

```tsx
      {onAddAgents && (
        <Button
          variant="default"
          size="xs"
          radius="md"
          data-testid="add-agents-button"
          aria-label={`Add agents to #${room.room}`}
          onClick={onAddAgents}
          disabled={!reachable}
          leftSection={<Icon name="userPlus" size={14} />}
          styles={{ root: CONTROL_SURFACE }}
        >
          add agents
        </Button>
      )}
```

with a 7.2px gap to the next control (`mr={7.2}` on the button or a spacer `Box w={7.2}`), and `fontWeight: 500` in its `styles.root` (Mantine's Button default is 600; the artboard's `.btn.sm` is 500 and the audit checks it).

- [ ] **Step 4: Transcript notice**

In `Transcript.tsx`, add `notice?: ReactNode` to `TranscriptProps` and render it above the `OlderEdge` mount but outside the `messages.length > 0 &&` guard, so a room created with `Create without inviting` (no messages yet) still shows it:

```tsx
            {notice && (
              <Box
                data-testid="transcript-notice"
                style={{ padding: '6px 0 4px', textAlign: 'left', fontSize: '10.56px', color: 'var(--tk-muted-text)' }}
              >
                {notice}
              </Box>
            )}
```

- [ ] **Step 5: App wiring**

In `src/app/App.tsx`:

1. `usePanesAvailable()`:

```ts
function usePanesAvailable(): boolean | undefined {
  const [available, setAvailable] = useState<boolean | undefined>(undefined);
  const probe = useCallback(() => {
    fetch('/api/panes')
      .then(res => res.json())
      .then((data: { available?: boolean }) => setAvailable(data.available === true))
      .catch(() => setAvailable(false));
  }, []);
  useEffect(() => {
    probe();
  }, [probe]);
  useInterval(probe, 30_000);
  return available;
}
```

2. State: `const panesAvailable = usePanesAvailable(); const [newRoomOpen, setNewRoomOpen] = useState(false); const [notice, setNotice] = useState<{ room: string; node: ReactNode } | null>(null);` and `const pickPanes = usePanePicker();` inside a child component that lives under `PanePickerProvider` (wrap the existing `AppChrome` subtree: `<BuddiesProvider ...><PanePickerProvider><AppChrome>...` and move the room page body into an inner component `ChatPage` that can call `usePanePicker()`), or keep App flat and put the `add agents` handler in a small `AddAgentsButtonHost`. The simplest: make `PanePickerProvider` wrap `<AppChrome>` inside `BuddiesProvider`, and move the JSX from `chatRoute ? (...)` into `function ChatPage(props)` rendered inside the provider.
3. `resultLine(results: InviteResult[], panes: ChatPane[])`:

```tsx
export function resultLine(results: InviteResult[], panes: ChatPane[]): ReactNode {
  const label = (r: InviteResult) => {
    const pane = panes.find(p => p.paneId === r.paneId);
    const name = pane?.presence?.handle ?? (pane?.workspace ? `${pane.workspace} pane` : r.paneId);
    if (r.delivered === 'accepted') return <span key={r.paneId} style={{ color: 'var(--mantine-color-ok-text)' }}>{name} accepted</span>;
    if (r.delivered === 'queued') return <span key={r.paneId} style={{ color: 'var(--mantine-color-warn-text)' }}>{name} queued (working)</span>;
    return <span key={r.paneId} style={{ color: 'var(--mantine-color-bad-text)' }}>{name} refused: {r.reason ?? 'unknown'}</span>;
  };
  return (
    <>
      invited {results.length}
      {results.map(r => (<span key={r.paneId}> · {label(r)}</span>))}
      {' · members appear as they sign in'}
    </>
  );
}
```

4. `add agents` handler on the open room:

```ts
async function addAgents() {
  if (!activeRoom) return;
  const picked = await pickPanes({
    context: `to invite to #${activeRoom}`,
    allowCreate: true,
    disable: p => (p.agentStatus === 'blocked' ? 'at a prompt · answer it first' : p.presence?.rooms.includes(activeRoom) ? `in #${activeRoom}` : null),
  });
  if (!picked || picked.length === 0) return;
  try {
    const res = await fetch('/api/chat/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: activeRoom, panes: picked.map(p => ({ paneId: p.paneId })) }) });
    if (!res.ok) throw new Error('invite failed');
    const { results } = (await res.json()) as { results: InviteResult[] };
    setNotice({ room: activeRoom, node: resultLine(results, picked) });
  } catch {
    notifications.error("Couldn't invite; nothing was typed into any pane.");
  }
}
```

5. `NewRoomModal` mounted with `opened={newRoomOpen}`, `onClose={() => setNewRoomOpen(false)}`, `daemonReachable={daemon.reachable}`, `onCreated={(room, results, picked) => { setNewRoomOpen(false); refetchRooms(); selectRoom(room); if (results.length) setNotice({ room, node: resultLine(results, picked) }); }}` (the three-argument signature Task 7 defines).
6. Pass `onNewRoom={panesAvailable ? () => setNewRoomOpen(true) : undefined}` and `daemonReachable={daemon.reachable}` to `RoomRail`; `onAddAgents={panesAvailable ? addAgents : undefined}` to `PageBar`; `notice={notice?.room === activeRoom ? notice.node : undefined}` to `Transcript`. Clear the notice when the room changes: `useEffect(() => { if (notice && notice.room !== activeRoom) setNotice(null); }, [activeRoom, notice]);` (drop this if the `room ===` gate above is enough for the tests; the spec says the line lasts until the next room change).

- [ ] **Step 6: Run the suite**

Run: `bunx vitest run && bun run typecheck && bun run lint`
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/ui/RoomRail.tsx src/ui/PageBar.tsx src/ui/Transcript.tsx src/app/App.tsx src/ui/RoomRail.test.tsx src/ui/PageBar.test.tsx src/ui/Transcript.test.tsx src/app/App.test.tsx src/ui/NewRoomModal.tsx
git commit -m "app: + in the rail, add agents in the page bar, invite results at the transcript edge"
```

---

### Task 9: artboards, anatomy, audit

**Files:**
- Modify: `design/build.py` (CSS block, ICON dict, four generators, canvas entries), `design/artboards/*.dc.html` (regenerated), `design/canvas.json`, `design/spec.json` (regenerated), `design/ANATOMY.md`, `design/audit.mjs`, `design/README.md`

**Interfaces:**
- Produces: artboards `NewRoom.dc.html`, `PanePicker.dc.html`, `NewPane.dc.html`, `EntryPoints.dc.html`; a new `.notice` rule in the shared CSS; `TARGETS` for `.pop` (the picker modal shell), `.pane`, `.cb`, `.peek`, `.btn.sm` (`add agents`), and the notice row (`.notice`). The rail `+` is a 24px control the spec's 28px `.aicon` does not describe; it is covered by the RoomRail test, not the audit.

- [ ] **Step 1: Fold the mockup generator into `design/build.py`**

The mockup generator is `/private/tmp/claude-501/-Users-matt-Documents-GitHub-chat/cb0994ad-4a10-49da-9f0f-b84d14861d54/scratchpad/pane-browser/build.py` (if that path is gone, the canvas at https://claude.ai/code/artifact/93d55ea7-54c1-4866-9685-bdc3b605661b holds the same four artboards; re-derive the generators from their markup). Into `design/build.py`:

1. Append its `EXTRA` CSS rules to the `CSS = r"""..."""` block (inside it; `extract-spec.py` only parses that block). Keep `.pane + .pane` as the row separator rule. Add one more rule for the invite result row, and use it in place of `.edge` in `entry_points()`: `.notice { padding: 6px 0 4px; text-align: left; font-size: 10.56px; color: var(--muted-text); }`.
2. Add its five `ICON` entries (`plus`, `x`, `eye`, `userplus`, `search`) to the `ICON` dict.
3. Paste its `PANES` table and the functions `pane_row`, `pane_list`, `picked_row`, `picked_list`, `new_room`, `picker`, `new_pane`, `entry_points` as module-level defs, using the repo's own `head()`/`tail()` (dark default `false`), and renaming the New room output to `NewRoom.dc.html`.
4. Add four `write_text` lines and four `canvas` entries placed below `y: 3060` (the laws note): `NewRoom` at `(0, 3200, 900, 900)`, `PanePicker` at `(1000, 3200, 820, 960)`, `NewPane` at `(1920, 3200, 720, 760)`, `EntryPoints` at `(0, 4300, 900, 560)`, plus the two annotations (`brief`, `states`) with matching `y` offsets. Update the final `print` count.

Run from `design/artboards`: `python3 ../build.py && cd .. && python3 extract-spec.py`. Expected: the four new files exist, `spec.json` gains the new selectors (`grep -c '"\.pane"' design/spec.json` is 1).

- [ ] **Step 2: ANATOMY**

Add to `design/ANATOMY.md`, after the Composer section:

```markdown
## Pane picker (Task 6)

A `.pop` modal, 640px (a full-height drawer on phones). Header: the terminal
icon, `Pick herdr panes` at 20px / 700, the caller's context in `.sm.muted`.
Then the filter `.input` (30px, 11.2px, search icon), a count line in
`.xs.muted` (`N panes running Claude · sorted listening, idle, deaf, not
signed in`) with `N selected` and, with `allowCreate`, a `.btn.sm` `new pane`
on the right. The list is a `.card` on `bg2`, `padding: 2px 0`, rows
separated by `--border-soft`.

Each row is a `.pane` (`gap: 9.6px`, `padding: 8.4px 9.6px`, radius 6px,
`align-items: flex-start`); `.pane.on` carries the accent wash, `.pane.na`
is `opacity: 0.55; cursor: default`.

| part | detail |
| --- | --- |
| checkbox | `.cb`, 16px, radius 4px; `.cb.on` accent-deep with a 11px check; `.cb.off` on `bg4` with a muted border for a row the caller disabled |
| dot | 8px `.dot` at `margin-top: 5px`, status colour; `.dot.off` hollow for a pane with no presence |
| who | the handle at `.sm` / 600, or `not signed in` in `.sm.muted` |
| where | `.xs.muted.truncate`, the workspace, plus ` · <title>` when the title is not the handle |
| state | `.state` on the right: `.working` (warn) `working · queues until its turn ends`, `.blocked` (bad) `at a prompt · answer it first`, `.idle` muted; a caller's reason replaces it |
| eye | a 22px `.aicon` |
| line 2 | `repo · branch` in `.xs.muted`, then `.tag`s for rooms |
| path | `…/leaf`, `.xs.muted`, real text (never `direction: rtl`) |
| peek | `.peek` inside the row: `bg1`, hairline, radius 4px, 11.2px, `white-space: pre`, own `overflow-x`; the prompt line in `--fg` |

Footer: a `.hint` (`the eye peeks at a pane's last lines...`), `Cancel`
(`.btn`), `Use N panes` (`.btn.primary`).

**New pane** is a second view in the same modal: back arrow + `New pane` +
`a herdr tab running Claude`; `.field`s (`.lbl2` label, `.input`, `.hint`)
for Directory (with a `.card` of `.opt` suggestions), a 2-column grid of
Account / Model then Effort / Workspace, and the Opening prompt `.area`;
footer hint with the launch command, `Back`, `Start pane`.

## New room (Task 7)

A `.pop` modal, 680px. Header: hash icon + `New room`. `.field`s: Room
(`#` prefix, hint `lowercase, digits, dashes · the room exists once you
post the seed`), Seed (`.input.area`, 96px min, hints `posted as matt · every
invitee is told to read it first` and `markdown subset · blank line between
points`), Wakes (a `.chip` select, hint `all = a war room, nobody has to
@here`). The Agents section: `AGENTS · N to invite` with `pick panes`
(`.btn.sm`, terminal icon) on the right; a `.card` of `.pane` rows without
checkboxes, each with a remove `.aicon` and a 28px note `.input`. Footer:
the hint (`N invites · <handle> picks it up when its turn ends`), `Create
without inviting` (`.btn`), `Create #<room> · invite N` (`.btn.primary`).

## Entry points (Task 8)

The rooms rail header gains a 24px `.aicon` `+` beside the count. The page
bar gains `add agents` (`.btn.sm`, user-plus icon) before `mark read`. After
an invite the transcript opens with a `.notice` row (the `.edge` values, left-aligned): `invited 2 ·
<ok>acme pane accepted</ok> · <warn>fred queued (working)</warn> ·
members appear as they sign in`. Both entry points hide when rt reports
herdr unavailable and disable with the daemon down.
```

- [ ] **Step 3: Audit targets**

In `design/audit.mjs`'s `TARGETS`, add:

```js
  { spec: '.pane', find: '[data-testid^="pane-row-"]', props: ['display', 'align-items', 'gap', 'border-radius', 'min-width', 'padding'], why: { padding: 'shorthand not enumerated by getComputedStyle; longhands verified by eye' } },
  { spec: '.cb', find: '[data-testid^="pane-check-"]', props: ['width', 'height', 'border-radius', 'display', 'align-items', 'justify-content'] },
  { spec: '.peek', find: '[data-testid^="pane-peek-"]:not([data-testid^="pane-peek-button-"])', props: ['padding', 'background', 'border-radius', 'font-size', 'line-height', 'white-space', 'overflow-x', 'color'], why: { padding: 'shorthand not enumerated by getComputedStyle; longhands verified by eye', 'white-space': WHITE_SPACE_NOT_ENUMERATED, 'line-height': LINE_HEIGHT_RESOLVES_TO_PX } },
  { spec: '.btn.sm', find: '[data-testid="add-agents-button"]', props: ['height', 'font-size', 'font-weight', 'border-radius'] },
  { spec: '.notice', find: '[data-testid="transcript-notice"]', props: ['padding', 'text-align', 'font-size', 'color'], why: { padding: 'shorthand not enumerated by getComputedStyle; longhands verified by eye' } },
```

and, for the picker's modal shell, a `.pop` entry finding `[data-testid="pane-picker"] .mantine-Modal-content` (check the class Mantine 9.5 renders for the content box in its docs) with the same props and `why` as the existing `.pop` entry.

- [ ] **Step 4: Run the audit against the fixtures server**

The audit needs the picker open, so it takes two captures (CONFORMANCE.md's documented flow, driven with Fast Browser):

```bash
bun run build
CHAT_FIXTURES=1 PORT=3111 bun src/server/index.ts &
node design/audit.mjs --probe > /Users/matt/.fast-browser/chat-shots/probe.js
```

Then with Fast Browser: navigate to `http://localhost:3111/r/build`, run the probe with `browser_evaluate` writing to `/Users/matt/.fast-browser/chat-shots/computed-page.json`; click `[data-testid="add-agents-button"]`, wait for `[data-testid="pane-row-w7A:pY"]`, click `[data-testid="pane-peek-button-w7A:pY"]`, wait for `[data-testid="pane-peek-w7A:pY"]`, run the probe again to `computed-picker.json`. Then:

```bash
node design/audit.mjs /Users/matt/.fast-browser/chat-shots/computed-page.json
node design/audit.mjs /Users/matt/.fast-browser/chat-shots/computed-picker.json
```

Expected: every target either passes or is absent from that capture (the page capture has no picker rows; the picker capture has both). Fix any value mismatch in the component, not in the artboard, and re-run. Repeat once in dark (`--scheme dark`). Kill the server. Open the canvas once (`design/canvas.json` positions) and check the new artboards at `y: 3200` do not overlap the laws note at `y: 3060`; move them down if they do.

- [ ] **Step 5: README and commit**

Add the four artboards to `design/README.md`'s file table. Then:

```bash
git add design
git commit -m "design: pane picker, new room, new pane and entry-point artboards, anatomy and audit targets"
```

---

### Task 10: final wiring, docs, PR

**Files:**
- Modify: `package.json` (if Task 1 used `file:`), `ARCHITECTURE.md` (routes and the picker in the client section), `design/CONFORMANCE.md` (the "not built" list)

- [ ] **Step 1: The rt-client pin**

If `package.json` carries `file:../repo-tools-chat-invite/...`, check `npm view @mattstack/rt-client version`. When `0.6.2` is published: `bun add @mattstack/rt-client@^0.6.2`, `bunx vitest run`, commit. If it is not published yet, stop here and report: the PR waits on the publish; do not open a PR with a `file:` dependency.

- [ ] **Step 2: Docs**

In `ARCHITECTURE.md`: add the five `/api/panes*` rows and the two `POST /api/chat/*` rows to the API table; in "Live updates" note that the room page refetches `who` on `chat/<room>/msg`; add a short "Panes" paragraph: `PanePicker` (provider + `usePanePicker()`), `NewRoomModal`, the two entry points, and that both hide when `GET /api/panes` reports `available: false`. In `design/CONFORMANCE.md`, under "Two things drawn that are deliberately not built", note that "no route addresses a pane by id" is no longer true for the picker (`/api/panes/:id/peek`) and stays true for the roster row.

- [ ] **Step 3: Full check and PR**

```bash
bun run typecheck && bun run lint && bunx vitest run && bun run build && bun run format:check
git add ARCHITECTURE.md design/CONFORMANCE.md package.json bun.lock
git commit -m "docs: pane routes, the picker, and the members refetch in ARCHITECTURE"
git push -u origin feat/pane-invite
gh pr create --title "Create rooms and invite herdr panes from the viewer" --body-file - <<'EOF'
## Rooms from the viewer, agents from herdr panes

Create a room, seed it, and invite or spawn herdr panes into it without leaving the chat. Spec: repo-tools `docs/superpowers/specs/2026-08-26-rt-chat-invite-design.md`; canvas: https://claude.ai/code/artifact/93d55ea7-54c1-4866-9685-bdc3b605661b.

### What changed

**Server** (`src/server/panes.ts`, `chat.ts`)

- `GET /api/panes`, `/accounts`, `/directories`, `/:id/peek`, `POST /api/panes` over rt-client's pane wrappers
- `POST /api/chat/rooms` joins as the human and posts the seed; `POST /api/chat/invite` types `/chat:join` into each pane in order
- herdr absent is `available: false`, not an error; fixtures for every route

**Client**

- `PanePicker`: provider-hosted, `usePanePicker()` resolves with the picked rows; filter, sort, peek, caller `disable`, `allowCreate` with the New pane form
- `NewRoomModal`: name, seed, wake mode, picked panes with notes; create, seed, invite in order
- `+` in the rooms rail, `add agents` in the page bar, the result line at the transcript edge
- members refetch on `chat/<room>/msg`

**Design**

- Four artboards in `build.py`, anatomy sections, audit targets; audit green against fixtures in both schemes

### Follow-up

- Focusing a pane from the roster is a future picker caller (CONFORMANCE.md).
EOF
```

---

## Self-review

**Spec coverage.** Routes table incl. `available: false` and 400 rules: Tasks 3, 4. Fixtures: Task 2. PanePicker contract (`context`, `multiple`, `disable`, `preselected`, `allowCreate`), owns fetch/filter/sort/peek/selection, resolves rows or `null`, New pane form fields and the `starting`/`ready:false` behaviour, herdr-unavailable notice: Task 6. New room form fields, picked list with notes, submit order, draft kept on failure: Task 7. Entry points (`+`, `add agents`), hide when unavailable, disable when the daemon is down, the notice line until the next room change, `who` refetch on `chat/<room>/msg`: Tasks 5 and 8. Phone drawers with 44px controls: Tasks 6 and 7 (`fullScreen` on `useIsMobile`). Path rendering via `headTruncatePath`: Task 6. Artboards into `build.py`, ANATOMY, audit TARGETS incl. the open-modal capture: Task 9. Delivery order and the rt-client pin: Tasks 1 and 10.

**Placeholders.** None. Task 6 Step 6 (`NewPaneForm`) and Task 7 Step 3 describe the components in prose with every field, label, test id and behaviour named rather than pasting a second 200-line file; both have tests that pin the behaviour.

**Type consistency.** `ChatPane`, `InviteResult`, `PaneAccount`, `PaneDirectory`, `AgentStatus` are rt-client's (re-exported from `src/ui/PanePicker/types.ts`). `PickPanesOptions`/`PickPanes` (Task 6) are what Task 7 and Task 8 call. Test ids are consistent across tasks: `pane-row-<id>`, `pane-check-<id>`, `pane-peek-button-<id>`, `pane-peek-<id>`, `pane-filter`, `pane-new`, `pane-start`, `pane-back`, `pane-use`, `pane-cancel`, `pane-picker`, `picked-<id>`, `new-room-pick`, `new-room-create`, `new-room-create-only`, `new-room-button`, `add-agents-button`, `transcript-notice`, `transcript-edge`. `onCreated(room, results, picked)` is the Task 8 amendment to Task 7's interface; both tasks say so.
