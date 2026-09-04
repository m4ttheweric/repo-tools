# Day-one settings corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the four rt-side corrections the day-one audit ruled: install the team's intercepts on a joiner's machine, seed the joiner's own chat and board identity, and put an invited handle on the suite roster.

**Architecture:** Three independent changes plus a docs pointer. C-A moves one entry in the pinned Install step order so `intercepts.install` runs after the repos it reads exist. C-B and C-C add one forge-login lookup to the existing `board.keys` step, sharing a new forge-resolution helper extracted from `git.identity` so both steps resolve a forge identically. C-D adds a second team-scope write to the invite's existing roster append.

**Tech Stack:** Bun, TypeScript, `bun:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-day-one-settings-audit-design.md`

## Global Constraints

- **No new registry key, and no rt-client publish.** rt main's registry is behind published rt-client 0.14.0; three keys live only on a held branch. Every key this plan writes is already registered.
- **No em dashes or en dashes** anywhere: not in code, comments, commit messages, or docs. Use "..." or rephrase.
- **Comments earn their place.** A comment states a constraint the code cannot show (an ordering trap, a non-obvious invariant, a why). No narration of the next line, no review-facing justification, no task or ticket numbers in source.
- **rt is public.** No employer, customer, or internal system names in any file. Neutral placeholders only (`acme`, `gitlab.example.com`). `scripts/repo-purity.sh` is the gate.
- **`bun run test` does not run e2e.** The verification below is scoped to `bun test lib packages/rt-client`, which is what these changes touch.
- Run every command from the worktree root: `/Users/matt/.mattstack/rt/worktrees/gh-m4ttstack-rt/frank-lantern`.
- Commit after every task. Never push.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lib/setup/contract.ts` | the pinned `STEP_IDS` order | 1 |
| `lib/setup/steps/index.ts` | the `STEPS` registry, same order | 1 |
| `lib/setup/__tests__/contract.test.ts` | asserts the pinned order and the new dependency | 1 |
| `lib/setup/steps/forge-identity.ts` | **new**: resolve the forge and its token for a step, one way for every caller | 2 |
| `lib/setup/steps/git-identity.ts` | uses the shared resolver instead of its own private copies | 2 |
| `lib/setup/steps/skills.ts` | `board.keys` also seeds the joiner's own handle into two user-scope keys | 2 |
| `lib/setup/__tests__/steps-b.test.ts` | `board.keys` seeding tests | 2 |
| `lib/team/invite.ts` | the roster append writes both roster keys | 3 |
| `lib/team/__tests__/invite.test.ts` | roster append tests | 3 |
| `docs/settings-architecture.md` | pointer to the day-one audit | 4 |

---

### Task 1: `intercepts.install` runs after `repos.clone`

`installShims()` builds its rules by iterating the repo index. At the current
position the index is empty on a fresh machine, so it writes an empty rules
cache, no shim is installed, and both `rt verify`'s `tool.intercepts` row and
`staleIntercepts()` then read that empty cache and report clean. Moving the
step after `repos.clone` is the whole fix: `repos.clone` awaits
`updateRepoIndexAsync` before returning, so the index is populated, not racing.

**Files:**
- Modify: `lib/setup/contract.ts` (the `STEP_IDS` array)
- Modify: `lib/setup/steps/index.ts` (the `STEPS` array)
- Test: `lib/setup/__tests__/contract.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks rely on. `STEP_IDS` keeps all 24 ids and its `StepId` type is unchanged; only the position of `"intercepts.install"` moves.

- [ ] **Step 1: Write the failing test**

Add this to `lib/setup/__tests__/contract.test.ts`, inside the existing
`describe("STEP_IDS", ...)` block, after the "matches the contract's 24 ids in
order" test:

```ts
  test("intercepts.install runs after repos.clone, which is what puts repos in the index it reads", () => {
    // installShims() builds its rules by iterating the repo index. Ahead of
    // repos.clone that index is empty on a fresh machine, so the step writes
    // an empty rules cache and every later probe reads it as "nothing
    // declared" instead of "not installed yet".
    expect(STEP_IDS.indexOf("intercepts.install")).toBeGreaterThan(STEP_IDS.indexOf("repos.clone"));
  });
```

Then add this to the same file, as a new top-level `describe` after the
`STEP_IDS` block. It needs one new import at the top of the file:

```ts
import { STEPS } from "../steps/index.ts";
```

```ts
describe("STEPS", () => {
  test("the runtime registry is in the contract's order", () => {
    expect(STEPS.map((s) => s.id)).toEqual([...STEP_IDS]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/setup/__tests__/contract.test.ts`

Expected: FAIL. The first new test fails with the received value `7` not being
greater than `9`. The second new test passes already (the two lists agree
today), and is there to keep them agreeing after the move.

- [ ] **Step 3: Move the entry in both lists**

In `lib/setup/contract.ts`, in `STEP_IDS`, delete the `"intercepts.install"`
line from between `"path.link"` and `"settings.seed"`, and add it back
immediately after `"repos.clone"`. The array becomes:

```ts
export const STEP_IDS = [
  "home.init",
  "home.restore",
  "team.create",
  "team.join",
  "secrets.write",
  "git.identity",
  "path.link",
  "settings.seed",
  "repos.clone",
  "intercepts.install",
  "services.register",
  "proxy.install",
  "deck.managed",
  "skills.materialize",
  "skills.link",
  "board.keys",
  "cron.triage",
  "plugins.install",
  "fastbrowser.setup",
  "herdr.integration",
  "extension.install",
  "services.start",
  "snapshot.push",
  "verify",
] as const;
```

In `lib/setup/steps/index.ts`, make `STEPS` match by moving
`interceptsInstallStep` from between `pathLinkStep` and `settingsSeedStep` to
immediately after `reposCloneStep`:

```ts
export const STEPS: StepDef[] = [
  homeInitStep,
  homeRestoreStep,
  teamCreateStep,
  teamJoinStep,
  secretsWriteStep,
  gitIdentityStep,
  pathLinkStep,
  settingsSeedStep,
  reposCloneStep,
  interceptsInstallStep,
  servicesRegisterStep,
  proxyInstallStep,
  deckManagedStep,
  skillsMaterializeStep,
  skillsLinkStep,
  boardKeysStep,
  cronTriageStep,
  pluginsInstallStep,
  fastbrowserSetupStep,
  herdrIntegrationStep,
  extensionInstallStep,
  servicesStartStep,
  snapshotPushStep,
  verifyStep,
];
```

Add a comment above `interceptsInstallStep`'s new position in
`lib/setup/steps/index.ts`, immediately before the `reposCloneStep` line:

```ts
  // intercepts.install reads the repo index, so it must stay behind
  // repos.clone: ahead of it the index is empty on a fresh machine and the
  // step silently writes an empty rules cache.
  reposCloneStep,
  interceptsInstallStep,
```

- [ ] **Step 4: Update the existing full-order assertion**

In `lib/setup/__tests__/contract.test.ts`, in the "matches the contract's 24
ids in order" test, move `"intercepts.install"` in the expected array to sit
after `"repos.clone"`, exactly as in Step 3.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test lib/setup/__tests__/contract.test.ts lib/setup/__tests__/steps-a.test.ts lib/setup/__tests__/apply.test.ts`

Expected: PASS, all files.

- [ ] **Step 6: Commit**

```bash
git add lib/setup/contract.ts lib/setup/steps/index.ts lib/setup/__tests__/contract.test.ts
git commit -m "setup: run intercepts.install after repos.clone, which fills the index it reads"
```

---

### Task 2: `board.keys` seeds the joiner's own handle

`chat.humanHandle` resolves to a registry default that is one specific
person's handle, and `board.defaultMember` has no writer at all. The invite the
joiner redeemed already proved their forge handle; this reads it back from the
forge and writes both keys at user scope, only when no store has written them.

The forge resolution is exactly what `git.identity` already does, so it is
extracted first rather than copied.

**Files:**
- Create: `lib/setup/steps/forge-identity.ts`
- Modify: `lib/setup/steps/git-identity.ts`
- Modify: `lib/setup/steps/skills.ts` (the `board.keys` section)
- Test: `lib/setup/__tests__/steps-b.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces, from `lib/setup/steps/forge-identity.ts`:
  - `export interface ResolvedForge { host: string; provider: "github" | "gitlab"; token: string | null }`
  - `export async function resolveForge(ctx: ApplyContext): Promise<ResolvedForge | null>`
  - `export function tokenRemoteFor(host: string): string`

- [ ] **Step 1: Write the failing tests**

Add this to `lib/setup/__tests__/steps-b.test.ts`, inside the existing
`describe("board.keys", ...)` block, after the last test in it.

First, add the import for `TeamSnapshot` at the top of the file if it is not
already imported:

```ts
import type { TeamSnapshot } from "../team-settings.ts";
```

Then the tests:

```ts
    const GITHUB_FORGE: TeamSnapshot = {
      slug: "acme",
      integrations: { forge: { host: "github.com", provider: "github" } },
      trackingIdentities: [],
      marketplaces: [],
      plugins: [],
      remote: null,
    };

    /** The forge login lookup is one `gh api user`; everything else the step does needs no exec. */
    function forgeLoginProbes(login: string) {
      return fakeProbes({
        home,
        exec: async (argv) => (argv[0] === "gh" && argv[1] === "api" ? ok(JSON.stringify({ login })) : ok("")),
      });
    }

    test("seeds chat.humanHandle and board.defaultMember from the joiner's own forge login", async () => {
      const p = forgeLoginProbes("zaphod");
      const { ctx } = makeCtx(p, { snapshot: GITHUB_FORGE });

      const outcome = await boardKeysStep.run(ctx);
      expect(detailOf(outcome)).toContain("chat.humanHandle");
      expect(detailOf(outcome)).toContain("board.defaultMember");
      expect(getSetting("chat.humanHandle").value).toBe("zaphod");
      expect(getSetting("board.defaultMember").value).toBe("zaphod");
    });

    test("chat.humanHandle's registry default does not count as set: the seed still fires over it", async () => {
      // getSetting() reports the registry default as a present value, so an
      // `undefined` check would read this key as already chosen on every
      // machine and the seed would never run.
      expect(getSetting("chat.humanHandle").value).toBe("matt");

      const p = forgeLoginProbes("trillian");
      const { ctx } = makeCtx(p, { snapshot: GITHUB_FORGE });
      await boardKeysStep.run(ctx);

      expect(getSetting("chat.humanHandle").value).toBe("trillian");
    });

    test("a handle the operator already chose is never overwritten", async () => {
      setSetting("chat.humanHandle", "ford", "user");
      setSetting("board.defaultMember", "ford", "user");
      const p = forgeLoginProbes("zaphod");
      const { ctx } = makeCtx(p, { snapshot: GITHUB_FORGE });

      const outcome = await boardKeysStep.run(ctx);
      expect(detailOf(outcome)).not.toContain("chat.humanHandle");
      expect(detailOf(outcome)).not.toContain("board.defaultMember");
      expect(getSetting("chat.humanHandle").value).toBe("ford");
      expect(getSetting("board.defaultMember").value).toBe("ford");
    });

    test("no forge connected: logs it and leaves both keys alone, never fails the step", async () => {
      const p = fakeProbes({ home });
      const { ctx, logs } = makeCtx(p, { snapshot: null });

      const outcome = await boardKeysStep.run(ctx);
      expect(outcome.state).toBe("done");
      expect(getSetting("board.defaultMember").value).toBeUndefined();
      expect(logs.some((l) => l.line.includes("no forge connected"))).toBe(true);
      expect(p.calls.exec).toEqual([]);
    });

    test("a forge that answers with no login: logs it and leaves both keys alone", async () => {
      const p = fakeProbes({ home, exec: async () => ({ code: 1, stdout: "", stderr: "not logged in" }) });
      const { ctx, logs } = makeCtx(p, { snapshot: GITHUB_FORGE });

      const outcome = await boardKeysStep.run(ctx);
      expect(outcome.state).toBe("done");
      expect(getSetting("board.defaultMember").value).toBeUndefined();
      expect(logs.some((l) => l.line.includes("forge login unavailable"))).toBe(true);
    });
```

Check the top of `steps-b.test.ts` for the helpers these use: `home`, `ok`,
`fakeProbes`, `makeCtx`, `detailOf`, `getSetting`, `setSetting`. All five tests
use only helpers that file already has, except `TeamSnapshot`. Do not redefine
any of them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/setup/__tests__/steps-b.test.ts -t "board.keys"`

Expected: FAIL. The seeding tests fail because nothing writes either key: the
first two on the `getSetting(...)` assertions, the last two on the missing log
lines.

- [ ] **Step 3: Extract the shared forge resolver**

Create `lib/setup/steps/forge-identity.ts`:

```ts
/**
 * Resolving "which forge is this person on, and with which token" is the same
 * question for every step that needs the operator's own forge account, and
 * the answer has three sources in a fixed precedence: the team's declared
 * forge, the forge implied by the team's remote, then the host the operator
 * confirmed for themselves during `rt setup <id> connect`. The last is all a
 * machine with no team has.
 */

import type { ApplyContext } from "../apply.ts";
import { isValidHostname } from "../host-validate.ts";
import { forgeFromHost, forgeFromRemote, readUserIntegrationOverrides } from "../team-settings.ts";
import { forgeTokenFor } from "./forge-token.ts";

export interface ResolvedForge {
  host: string;
  provider: "github" | "gitlab";
  token: string | null;
}

/**
 * `forgeTokenFor` derives the token's key from the host inside a full remote
 * URL, and a bare `https://host/` does not parse as one. The path segment is
 * inert: only the host decides which token rt holds.
 */
export function tokenRemoteFor(host: string): string {
  return `https://${host}/mattstack/identity`;
}

/**
 * Hostname-validated: nothing but a real host may reach `gh`/`glab`.
 */
function connectedForge(): { host: string; provider: "github" | "gitlab" } | null {
  const host = readUserIntegrationOverrides().forgeHost;
  return host && isValidHostname(host) ? forgeFromHost(host) : null;
}

/** Null when no forge is connected at all. Redacts the token it resolves. */
export async function resolveForge(ctx: ApplyContext): Promise<ResolvedForge | null> {
  const forge =
    ctx.snapshot?.integrations.forge ??
    (ctx.snapshot?.remote ? forgeFromRemote(ctx.snapshot.remote) : null) ??
    connectedForge();
  if (!forge) return null;

  const token = await forgeTokenFor(ctx, tokenRemoteFor(forge.host));
  if (token) ctx.redact(token);
  return { host: forge.host, provider: forge.provider, token };
}
```

- [ ] **Step 4: Point `git.identity` at the shared resolver**

In `lib/setup/steps/git-identity.ts`:

1. Delete the private `tokenRemoteFor` function and its docblock, and delete
   the private `connectedForge` function and its docblock.
2. Delete the now-unused imports: `isValidHostname` from `../host-validate.ts`,
   `forgeFromHost`, `forgeFromRemote` and `readUserIntegrationOverrides` from
   `../team-settings.ts`, and `forgeTokenFor` from `./forge-token.ts`. Keep
   `forgeProfile` from `../../team/forge.ts`.
3. Add: `import { resolveForge } from "./forge-identity.ts";`
4. In `gitIdentityRun`, replace the forge and token block:

```ts
  const forge = ctx.snapshot?.integrations.forge ?? (ctx.snapshot?.remote ? forgeFromRemote(ctx.snapshot.remote) : null) ?? connectedForge();
  if (!forge) return { state: "skipped", detail: `no forge connected; ${MANUAL}` };

  const token = await forgeTokenFor(ctx, tokenRemoteFor(forge.host));
  if (token) ctx.redact(token);

  const profile = await forgeProfile(ctx.p, forge.provider, forge.host, token, (detail) => ctx.log("git.identity", detail));
```

with:

```ts
  const forge = await resolveForge(ctx);
  if (!forge) return { state: "skipped", detail: `no forge connected; ${MANUAL}` };

  const profile = await forgeProfile(ctx.p, forge.provider, forge.host, forge.token, (detail) => ctx.log("git.identity", detail));
```

Nothing else in the file changes. The behavior is identical, including the
hostname validation and the token redaction.

- [ ] **Step 5: Run the `git.identity` tests to verify the refactor is inert**

Run: `bun test lib/setup/__tests__/steps-c.test.ts -t "git.identity"`

Expected: PASS, unchanged. If any test fails here the extraction changed
behavior; fix the extraction, not the test.

- [ ] **Step 6: Seed the two keys in `board.keys`**

In `lib/setup/steps/skills.ts`, add to the imports:

```ts
import { forgeLogin } from "../../team/forge.ts";
import { resolveForge } from "./forge-identity.ts";
```

Add this helper next to the existing `isUnset` helper in the `board.keys`
section:

```ts
/**
 * `isUnset` reads a registry default as a present value, so a key that HAS a
 * default (chat.humanHandle) would read as already chosen on every machine.
 * This asks the narrower question a seed needs: has any store written it.
 */
function unwritten(key: string): boolean {
  const existing = getSetting(key);
  return existing.provenance.length === 0 || existing.provenance.every((p) => p.scope === "default");
}
```

Add this function above `boardKeysRun`:

```ts
/**
 * The joiner's own forge handle, which is both who their board runs as and
 * who agents address in chat. Neither key has a writer anywhere else, and
 * chat.humanHandle's registry default is somebody else's handle, so an
 * unseeded machine is wrong rather than merely unconfigured.
 */
async function seedOwnHandle(ctx: ApplyContext, written: string[]): Promise<void> {
  if (!unwritten("chat.humanHandle") && !unwritten("board.defaultMember")) return;

  const forge = await resolveForge(ctx);
  if (!forge) {
    ctx.log("board.keys", "chat.humanHandle/board.defaultMember: no forge connected, left unset");
    return;
  }

  const login = await forgeLogin(ctx.p, forge.provider, forge.host, forge.token);
  if (!login) {
    ctx.log("board.keys", "chat.humanHandle/board.defaultMember: forge login unavailable, left unset");
    return;
  }

  if (unwritten("chat.humanHandle")) {
    setSetting("chat.humanHandle", login, "user");
    written.push("chat.humanHandle");
  }
  if (unwritten("board.defaultMember")) {
    setSetting("board.defaultMember", login, "user");
    written.push("board.defaultMember");
  }
}
```

In `boardKeysRun`, call it immediately before the `return`, so its keys land in
the same `wrote:` detail line:

```ts
  await seedOwnHandle(ctx, written);

  return { state: "done", detail: written.length > 0 ? `wrote: ${written.join(", ")}` : "nothing to write" };
}
```

Both keys are already in the registry, so no `writable()` guard is needed; the
existing guard exists for keys that might not be registered yet.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test lib/setup/__tests__/steps-b.test.ts lib/setup/__tests__/steps-c.test.ts`

Expected: PASS, both files. The three pre-existing `board.keys` tests still
pass: they run with `snapshot: null` or a snapshot with no forge, so the seed
takes the "no forge connected" branch, logs, and adds nothing to `written`.
If the "no tracked repos and no repo root" test now fails on its exact
`detail: "wrote: gitq.board"` assertion, the seed fired when it should not
have; fix the guard, not the assertion.

- [ ] **Step 8: Commit**

```bash
git add lib/setup/steps/forge-identity.ts lib/setup/steps/git-identity.ts lib/setup/steps/skills.ts lib/setup/__tests__/steps-b.test.ts
git commit -m "board.keys: seed chat.humanHandle and board.defaultMember from the operator's forge login"
```

---

### Task 3: an invited handle joins the suite roster

`mattstack.roster` is the registered cross-app roster and has no writer at all.
`rt team invite`'s `addToRoster` writes `board.members` alone, so an invitee is
invisible to anything reading the successor key.

**Files:**
- Modify: `lib/team/invite.ts` (`addToRoster`)
- Test: `lib/team/__tests__/invite.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1 or 2.
- Produces: nothing other tasks rely on. `addToRoster` keeps its signature `(seams: MintInviteSeams, slug: string, handle: string): void`.

- [ ] **Step 1: Write the failing tests**

In `lib/team/__tests__/invite.test.ts`, add these two tests immediately after
the existing "does not re-add a handle already on the team's own roster" test:

```ts
  test("also appends the handle to mattstack.roster, the cross-app roster", async () => {
    const p = probesWithRemote(REMOTE);
    const { seams, writeCalls } = baseSeams();
    const relay = fakeRelayClient();

    await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    expect(writeCalls).toContainEqual({
      key: "mattstack.roster",
      value: [{ username: "zaphod" }],
      scope: "team",
      opts: { team: SLUG },
    });
  });

  test("each roster key is judged on its own contents: a handle on one and not the other gets the missing write only", async () => {
    const p = probesWithRemote(REMOTE);
    const { seams, writeCalls } = baseSeams({
      readTeamStore: () => ({ "board.members": [{ username: "zaphod" }], "mattstack.roster": [] }),
    });
    const relay = fakeRelayClient();

    await mintInvite(p, relay.client, { slug: SLUG, handle: "zaphod", now: NOW }, seams);

    expect(writeCalls).toEqual([
      { key: "mattstack.roster", value: [{ username: "zaphod" }], scope: "team", opts: { team: SLUG } },
    ]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/team/__tests__/invite.test.ts -t "roster"`

Expected: FAIL. Both new tests fail because nothing writes `mattstack.roster`.

- [ ] **Step 3: Write both roster keys**

In `lib/team/invite.ts`, replace `addToRoster` with:

```ts
/** Both roster keys, each judged on its own contents: board.members is the board's own list, mattstack.roster the cross-app successor, and a store can legitimately carry one without the other. */
function addToRoster(seams: MintInviteSeams, slug: string, handle: string): void {
  const store = seams.readTeamStore(slug);
  for (const key of ["board.members", "mattstack.roster"] as const) {
    const existing = Array.isArray(store[key]) ? (store[key] as BoardMember[]) : [];
    if (existing.some((m) => m.username === handle)) continue;
    seams.writeSetting(key, [...existing, { username: handle }], "team", { team: slug });
  }
}
```

- [ ] **Step 4: Update the three existing assertions that counted writes**

Three tests in the same file assert on the exact number or content of
`writeCalls` and now see two writes where they saw one. Each is a real contract
change, not a broken test.

In "appends the handle to board.members via the writeSetting seam, unless
already present", replace:

```ts
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]).toEqual({
      key: "board.members",
      value: [{ username: "zaphod" }],
      scope: "team",
      opts: { team: SLUG },
    });
```

with:

```ts
    expect(writeCalls).toEqual([
      { key: "board.members", value: [{ username: "zaphod" }], scope: "team", opts: { team: SLUG } },
      { key: "mattstack.roster", value: [{ username: "zaphod" }], scope: "team", opts: { team: SLUG } },
    ]);
```

In "does not re-add a handle already on the team's own roster", the fixture
seeds only `board.members`, so the roster write is still expected. Replace:

```ts
    const { seams, writeCalls } = baseSeams({ readTeamStore: () => ({ "board.members": [{ username: "zaphod" }] }) });
```

with:

```ts
    const { seams, writeCalls } = baseSeams({
      readTeamStore: () => ({ "board.members": [{ username: "zaphod" }], "mattstack.roster": [{ username: "zaphod" }] }),
    });
```

and leave its `expect(writeCalls).toHaveLength(0);` as it is.

In "addToRoster consults the team's OWN store, not the multi-team overlay
`read` exposes", replace:

```ts
    expect(writeCalls).toHaveLength(1);
```

with:

```ts
    expect(writeCalls.map((c) => c.key)).toEqual(["board.members", "mattstack.roster"]);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test lib/team/__tests__/invite.test.ts`

Expected: PASS, whole file. If "persists the mint record for later
revoke/replace, 0600, BEFORE grantRead/addToRoster run" fails, read it before
touching it: it asserts ordering, not write count, and should be unaffected.

- [ ] **Step 6: Commit**

```bash
git add lib/team/invite.ts lib/team/__tests__/invite.test.ts
git commit -m "team invite: put the invited handle on mattstack.roster as well as board.members"
```

---

### Task 4: point the architecture doc at the audit, and verify the branch

**Files:**
- Modify: `docs/settings-architecture.md`

**Interfaces:**
- Consumes: Tasks 1 to 3 landed.
- Produces: nothing.

- [ ] **Step 1: Add the pointer**

In `docs/settings-architecture.md`, in the "Per-app key tables" section at the
end of the file, add this paragraph after the existing one:

```markdown
For what each key resolves to on a NEW teammate's machine the moment Install
finishes ... who writes it, whether it travels with the team store, and what
is still missing ... see
[the day-one audit](superpowers/specs/2026-09-03-day-one-settings-audit-design.md).
```

- [ ] **Step 2: Run the full verification**

Run each, from the worktree root:

```bash
bun test lib packages/rt-client
bun x tsc --noEmit
bun run docs:check
scripts/repo-purity.sh
```

Expected: all four green. `bun run test` is not the gate here; e2e is a
separate suite and none of these changes touch a verbatim end-to-end format.

- [ ] **Step 3: Commit**

```bash
git add docs/settings-architecture.md
git commit -m "docs: point the settings architecture at the day-one audit"
```

---

## Self-review notes

- **Spec coverage.** C-A is Task 1, C-B and C-C are Task 2, C-D is Task 3. The
  spec's "Recorded, not implemented here" table is deliberately not
  implemented; the spec is its record.
- **The trap most likely to be missed** is `chat.humanHandle`'s registry
  default reading as a present value. Task 2 Step 6 introduces `unwritten()`
  for exactly that, and Task 2 Step 1's second test fails loudly if an
  implementer reaches for the existing `isUnset` instead.
- **The second trap** is Task 3's three pre-existing assertions. They are
  listed individually with their replacements so the change is deliberate
  rather than discovered.
