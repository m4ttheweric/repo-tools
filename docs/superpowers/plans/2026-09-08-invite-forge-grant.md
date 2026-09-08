# Invite Forge Grant + Pull-Only Members Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `rt team invite` actually grant forge read access on repos rt created, make every other repo say honestly that an admin must grant it, and stop member machines pushing to the team repo.

**Architecture:** The MAT-387 latch in `lib/team/team-local.ts` already models this; it was never latched. A third provenance field (`joinedByRt`) joins `createdByRt` there, the invite gate becomes three-way, and the daemon's snapshot engine gains a pull-only mode that member clones run in. Team-scope writes from a member refuse at their choke points.

**Tech Stack:** Bun + TypeScript. `bun test` (bun:test). `gh`/`glab` shelled through `forgeArgv`. No UI code in the TS CLI: prompts go through the `lib/ui/prompts.ts` facade.

**Spec:** `docs/superpowers/specs/2026-09-07-invite-forge-grant-design.md` (read it first; this plan argues from it)

## Global Constraints

- **Read-level grant only.** GitHub `permission=pull`, GitLab `access_level=20`. Never raise these.
- **Never edit branch protection**, in either direction, anywhere.
- **No em dashes or en dashes** in any new string, comment, commit message, or doc.
- **Comments state constraints the code cannot show.** No narration of the next line, no ticket numbers or review findings in source. User-facing error *text* may name MAT-415; source comments may not.
- **The TS CLI is UI-free.** Prompts only via `lib/ui/prompts.ts` / `lib/rt-render.ts`, only behind `interactive()`.
- **Every leaf picker gates `process.stdin.isTTY && !json && !process.env.RT_BATCH`.** The non-TTY path keeps its existing usage string, exit code, and JSON envelope byte for byte.
- **`bun run test:all`, not `bun run test`.** e2e is a separate script and verbatim formats fail only there.
- **After touching `packages/rt-client`, run `bun run build` in that package.** `file:` consumers copy `dist/` verbatim.
- No `SCHEMA_VERSION` bump and no rt-client npm publish in this plan.

---

## File Structure

**Modified**

- `lib/team/team-local.ts`: the record gains `joinedByRt`. Still the only owner of the whole record.
- `lib/team/join.ts`: writes `joinedByRt` before cloning.
- `lib/team/forge.ts`: exports `membershipSteps`.
- `lib/team/invite.ts`: three-way gate.
- `lib/team/publish.ts`, `lib/team/members.ts`, `lib/secrets/team-store.ts`: refusal guards.
- `commands/team.ts`: the offer prompt, the early refusal, the new `manage-membership` verb.
- `commands/secrets.ts`: unchanged; its guard lives in `writeTeamSecret` (see Task 9).
- `lib/setup/steps/secrets.ts`: catches the refusal, reports `skipped`.
- `lib/command-tree-def.ts`: the new verb, and the corrected `invite` description.
- `lib/daemon/home-snapshot.ts`: `pullOnly` on the spec, guards at the commit and push seams, `pullOnly` on status.
- `lib/daemon/team-snapshots.ts`: computes the mode per clone and recomputes it per rescan.
- `lib/setup/validators/access.ts`: the `read/write` wording.
- `lib/setup/validators/rt-health.ts`: `team.sync` reports pull-only.
- `packages/rt-client/src/settings/paths.ts`: mirrors `teamLocalPath`.
- `packages/rt-client/src/settings/write.ts`: guards both resolvers.

**Created**

- `packages/rt-client/src/settings/team-local-read.ts`: reads one field, `joinedByRt`, for the guard.
- `e2e/tests/team-membership.test.ts`: the new verb's envelope and usage string.

**No change needed** (asserted by test, not by edit): `lib/variations.ts` already catches the refusal and returns `{ ok: false, reason: "write-failed" }`.

`lib/module-registry.ts` needs no entry: the new verb lands in `commands/team.ts`, already registered at line 57.

---

### Task 1: `joinedByRt` on the record, written before the clone

**Files:**
- Modify: `lib/team/team-local.ts:17-58`
- Modify: `lib/team/join.ts:344-361`
- Test: `lib/team/__tests__/team-local.test.ts`, `lib/team/__tests__/join.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TeamLocalRecord { createdByRt: boolean; joinedByRt: boolean; rtMayManageMembership: boolean }`. Every later task reads `joinedByRt` or `createdByRt` off `readTeamLocal(p, slug)`.

**Heads-up before you start:** adding a required field breaks every test fake that returns a whole record literal. TypeScript will flag all of them. They are at `lib/team/__tests__/invite.test.ts:111,438,459,473,488`, `lib/team/__tests__/members.test.ts:173,535,565,713`, and several in `lib/team/__tests__/team-local.test.ts`. Add `joinedByRt: false` to each. That is mechanical and expected, not a sign you did something wrong.

- [ ] **Step 1: Write the failing tests**

In `lib/team/__tests__/team-local.test.ts`:

```ts
test("joinedByRt defaults to false and round-trips", () => {
  const p = fakeProbes({ home: HOME });
  expect(readTeamLocal(p, SLUG).joinedByRt).toBe(false);
  updateTeamLocal(p, SLUG, { joinedByRt: true });
  expect(readTeamLocal(p, SLUG)).toEqual({ createdByRt: false, joinedByRt: true, rtMayManageMembership: false });
});

test("a non-boolean joinedByRt is not truthy-coerced", () => {
  const p = fakeProbes({ home: HOME, files: { [teamLocalPath(HOME, SLUG)]: JSON.stringify({ joinedByRt: "yes" }) } });
  expect(readTeamLocal(p, SLUG).joinedByRt).toBe(false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test lib/team/__tests__/team-local.test.ts`
Expected: FAIL, `joinedByRt` is undefined.

- [ ] **Step 3: Add the field**

In `lib/team/team-local.ts`, add to `TeamLocalRecord` after `createdByRt`:

```ts
  /**
   * This machine's clone arrived by redeeming an invite. Provenance, like
   * `createdByRt`, and confers nothing on its own: it decides only that this
   * machine's snapshot engine is pull-only, because members do not push the
   * team repo. Absent means false, so a clone that predates this field keeps
   * pushing rather than silently going inert.
   */
  joinedByRt: boolean;
```

Update `EMPTY` and the `readTeamLocal` parse:

```ts
const EMPTY: TeamLocalRecord = { createdByRt: false, joinedByRt: false, rtMayManageMembership: false };
```

```ts
    return {
      createdByRt: parsed.createdByRt === true,
      joinedByRt: parsed.joinedByRt === true,
      rtMayManageMembership: parsed.rtMayManageMembership === true,
    };
```

- [ ] **Step 4: Run, then fix the fakes**

Run: `bun test lib/team commands/__tests__/team.test.ts`
Expected: the two new tests PASS; type errors and failures in the fake literals listed above. Add `joinedByRt: false` to each. Re-run until green.

- [ ] **Step 5: Write the failing join test**

In `lib/team/__tests__/join.test.ts`, following that file's existing `joinRedeem` setup:

```ts
test("records joinedByRt BEFORE the clone runs, so the daemon watcher cannot race it", async () => {
  const seen: string[] = [];
  const p = probesForRedeem();
  const original = p.exec;
  p.exec = async (argv, opts) => {
    if (argv.includes("clone")) seen.push(readTeamLocal(p, TEAM_SLUG).joinedByRt ? "flag-first" : "clone-first");
    return original(argv, opts);
  };

  await joinRedeem(p, relay, secretsFactory, { code: CODE }, seams);

  expect(seen).toEqual(["flag-first"]);
  expect(readTeamLocal(p, TEAM_SLUG).joinedByRt).toBe(true);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test lib/team/__tests__/join.test.ts -t "joinedByRt"`
Expected: FAIL with `["clone-first"]` or an empty array.

- [ ] **Step 7: Write the flag before the clone**

In `lib/team/join.ts`, import `updateTeamLocal` from `./team-local.ts`, and insert immediately after `const dir = join(p.home, ".mattstack", "teams", pointer.team);` (line 344) and before the origin check and clone:

```ts
  // Ordering is the point: the clone creates ~/.mattstack/teams/<slug>, which
  // is what the daemon's teams/ watcher fires on. Recording after the clone
  // races that watcher for the mode of the engine it starts.
  updateTeamLocal(p, pointer.team, { joinedByRt: true });
```

- [ ] **Step 8: Run the tests**

Run: `bun test lib/team commands/__tests__/team.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/team commands/__tests__/team.test.ts
git commit -m "team-local: add joinedByRt, written by redeem before the clone"
```

---

### Task 2: `membershipSteps` in forge.ts

**Files:**
- Modify: `lib/team/forge.ts` (near `grantRead`)
- Test: `lib/team/__tests__/forge.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function membershipSteps(remote: string, handle: string): string[]`, returning the forge's own member-page steps or `[]` for a remote it cannot parse. Task 3 consumes it.

- [ ] **Step 1: Write the failing tests**

In `lib/team/__tests__/forge.test.ts`:

```ts
describe("membershipSteps", () => {
  test("GitHub: the repo's access settings page", () => {
    expect(membershipSteps("git@github.com:acme/widgets.git", "octocat")).toEqual([
      "Open https://github.com/acme/widgets/settings/access",
      "Invite octocat with Read",
    ]);
  });

  test("GitLab: the project's members page, on the remote's own host", () => {
    expect(membershipSteps("https://gitlab.example.com/acme/sub/widgets.git", "octocat")).toEqual([
      "Open https://gitlab.example.com/acme/sub/widgets/-/project_members",
      "Invite octocat with Reporter access",
    ]);
  });

  test("a remote it cannot parse yields no steps, never a guessed URL", () => {
    expect(membershipSteps("not-a-remote", "octocat")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test lib/team/__tests__/forge.test.ts -t membershipSteps`
Expected: FAIL, `membershipSteps` is not exported.

- [ ] **Step 3: Implement**

In `lib/team/forge.ts`, immediately above `grantRead`:

```ts
/**
 * The forge's own "add a member" steps for a handle, with no CLI call and no
 * claim that anything was done. This is what an invite prints where rt is not
 * permitted to grant, so it must never guess: a remote it cannot parse yields
 * nothing, and the caller supplies the sentence that is always true.
 */
export function membershipSteps(remote: string, handle: string): string[] {
  const parsed = parseForgeRemote(remote);
  if (!parsed) return [];
  if (parsed.provider === "github") {
    const { owner, repo } = splitOwnerRepo(parsed.path);
    return githubBaseSteps(owner, repo, handle, "Invite");
  }
  return gitlabBaseSteps(parsed.host, parsed.path, handle, "Invite");
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test lib/team/__tests__/forge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/team/forge.ts lib/team/__tests__/forge.test.ts
git commit -m "forge: export membershipSteps for the not-permitted invite path"
```

---

### Task 3: The three-way gate in `mintInvite`

**Files:**
- Modify: `lib/team/invite.ts:165-176`
- Test: `lib/team/__tests__/invite.test.ts:434-497`

**Interfaces:**
- Consumes: `membershipSteps` (Task 2); `TeamLocalRecord.createdByRt` (Task 1).
- Produces: `InviteResult.forgeAccess` / `.manualSteps` unchanged in type. Task 5 renders them.

**Read first:** the existing `describe("mintInvite: forge membership is not rt's to grant")` block at `lib/team/__tests__/invite.test.ts:434-497`. Its `!createdByRt` cases keep their meaning exactly. You are adding a case, not loosening one.

- [ ] **Step 1: Write the failing tests**

Add to that describe block:

```ts
test("createdByRt without the permission points at the opt-in verb, and still never calls the forge", async () => {
  let called = false;
  const { seams } = baseSeams({
    readTeamLocal: () => ({ createdByRt: true, joinedByRt: false, rtMayManageMembership: false }),
    grantRead: async () => { called = true; return { access: "granted" as const, manualSteps: [] }; },
  });
  const result = await mintInvite(probesWithRemote(REMOTE), fakeRelay(), { slug: SLUG, handle: "zaphod", now: NOW }, seams);

  expect(called).toBe(false);
  expect(result.forgeAccess).toBe("skipped");
  expect(result.manualSteps[0]).toContain("rt team manage-membership on --team acme");
  expect(result.manualSteps).toContain("Open https://github.com/acme/widgets/settings/access");
});

test("the permission alone does not grant on a repo rt did not create", async () => {
  let called = false;
  const { seams } = baseSeams({
    readTeamLocal: () => ({ createdByRt: false, joinedByRt: false, rtMayManageMembership: true }),
    grantRead: async () => { called = true; return { access: "granted" as const, manualSteps: [] }; },
  });
  const result = await mintInvite(probesWithRemote(REMOTE), fakeRelay(), { slug: SLUG, handle: "zaphod", now: NOW }, seams);

  expect(called).toBe(false);
  expect(result.forgeAccess).toBe("skipped");
});

test("an unparseable remote still gets the admin sentence, never an empty steps list", async () => {
  const { seams } = baseSeams({ readTeamLocal: () => ({ createdByRt: false, joinedByRt: false, rtMayManageMembership: false }) });
  const result = await mintInvite(probesWithRemote("weird://host/thing"), fakeRelay(), { slug: SLUG, handle: "zaphod", now: NOW }, seams);

  expect(result.manualSteps.length).toBeGreaterThan(0);
  expect(result.manualSteps.at(-1)).toContain("Ask whoever administers");
});
```

Use whatever the file already calls its relay stub in place of `fakeRelay()`.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test lib/team/__tests__/invite.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement the gate**

In `lib/team/invite.ts`, import `membershipSteps` alongside `grantRead`, and add above `mintInvite`:

```ts
/**
 * rt administers membership only where it created the repo AND the operator
 * granted the permission (MAT-387). Both, not either: the record is a file, so
 * requiring only the permission would let a hand-edited flag act on a repo rt
 * was merely pointed at.
 */
async function resolveForgeAccess(
  p: Probes,
  seams: MintInviteSeams,
  slug: string,
  remote: string,
  handle: string,
  token: string | null,
): Promise<{ access: ForgeAccess; manualSteps: string[] }> {
  const local = seams.readTeamLocal(p, slug);
  if (local.createdByRt && local.rtMayManageMembership) {
    return seams.grantRead(p, remote, handle, token);
  }
  if (local.createdByRt) {
    return {
      access: "skipped",
      manualSteps: [
        `Let mattstack grant it: run \`rt team manage-membership on --team ${slug}\`, then invite ${handle} again`,
        ...membershipSteps(remote, handle),
      ],
    };
  }
  // The admin sentence is appended here, never returned by membershipSteps,
  // so a remote that cannot be parsed still leaves the reader one true line.
  return {
    access: "skipped",
    manualSteps: [
      ...membershipSteps(remote, handle),
      `Ask whoever administers ${remote} to give ${handle} read access. mattstack did not create this repo, so your admin decides.`,
    ],
  };
}
```

Replace the ternary at lines 165-176 with:

```ts
  const { access: forgeAccess, manualSteps } = await resolveForgeAccess(p, seams, opts.slug, remote, opts.handle, token);
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test lib/team/__tests__/invite.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/team/invite.ts lib/team/__tests__/invite.test.ts
git commit -m "invite: three-way forge gate, requiring createdByRt and the permission"
```

---

### Task 4: `rt team manage-membership`

**Files:**
- Modify: `commands/team.ts` (new exported handler), `lib/command-tree-def.ts:1823-1915`
- Test: `commands/__tests__/team.test.ts`, `e2e/tests/team-membership.test.ts` (create)

**Interfaces:**
- Consumes: `readTeamLocal` / `updateTeamLocal` (Task 1); `resolveTeamSlug` (already in `commands/team.ts:150`).
- Produces: `export async function teamManageMembership(args: string[], _ctx?: CommandContext, deps?: TeamDeps): Promise<void>`. Task 5's needs-you text names this verb.

- [ ] **Step 1: Write the failing unit tests**

In `commands/__tests__/team.test.ts`:

```ts
describe("teamManageMembership", () => {
  test("bare form reports the state and whether it can be offered at all", async () => {
    const deps = manageDeps({ createdByRt: true, joinedByRt: false, rtMayManageMembership: false });
    await teamManageMembership(["--team", "acme", "--json"], {}, deps);

    const parsed = JSON.parse(deps.lines[0]!);
    expect(parsed.mayManage).toBe(false);
    expect(parsed.offerable).toBe(true);
  });

  test("on writes the permission", async () => {
    const deps = manageDeps({ createdByRt: true, joinedByRt: false, rtMayManageMembership: false });
    await teamManageMembership(["on", "--team", "acme", "--json"], {}, deps);

    expect(readTeamLocal(deps.probes, "acme").rtMayManageMembership).toBe(true);
  });

  test("on is refused where rt did not create the repo, and writes nothing", async () => {
    const deps = manageDeps({ createdByRt: false, joinedByRt: false, rtMayManageMembership: false });
    await teamManageMembership(["on", "--team", "acme", "--json"], {}, deps);

    expect(deps.exitCode).toBe(2);
    expect(JSON.parse(deps.lines[0]!).failure.code).toBe("not-rt-created");
    expect(readTeamLocal(deps.probes, "acme").rtMayManageMembership).toBe(false);
  });

  test("off clears it", async () => {
    const deps = manageDeps({ createdByRt: true, joinedByRt: false, rtMayManageMembership: true });
    await teamManageMembership(["off", "--team", "acme", "--json"], {}, deps);

    expect(readTeamLocal(deps.probes, "acme").rtMayManageMembership).toBe(false);
  });
});
```

Build `manageDeps` from the file's existing deps helper, seeding the record with `writeTeamLocal` against the fake home.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test commands/__tests__/team.test.ts -t teamManageMembership`
Expected: FAIL, not exported.

- [ ] **Step 3: Implement the handler**

In `commands/team.ts`, importing `readTeamLocal` and `updateTeamLocal` from `../lib/team/team-local.ts`:

```ts
/**
 * The permission is machine-local and never synced, so this is the only
 * non-interactive door to it. `on` is refused rather than ignored where rt did
 * not create the repo: rt does not administer a repo it was pointed at.
 */
export async function teamManageMembership(args: string[], _ctx: CommandContext = {}, deps: TeamDeps = realTeamDeps()): Promise<void> {
  const json = args.includes("--json");
  try {
    const slug = resolveTeamSlug(args);
    const state = positional(args, ["--team"])[0];
    if (state !== undefined && state !== "on" && state !== "off") {
      throw new UserActionableError("usage", "usage: rt team manage-membership [on|off] [--team <slug>] [--json]");
    }

    const before = readTeamLocal(deps.probes, slug);
    if (state === "on" && !before.createdByRt) {
      throw new UserActionableError(
        "not-rt-created",
        `mattstack did not create the repo behind "${slug}", so it will not administer membership there. Whoever administers that repo grants access.`,
      );
    }

    const record = state === undefined ? before : updateTeamLocal(deps.probes, slug, { rtMayManageMembership: state === "on" });

    if (json) {
      deps.print(JSON.stringify(envelope({ slug, mayManage: record.rtMayManageMembership, offerable: record.createdByRt })));
      return;
    }
    deps.print(
      record.rtMayManageMembership
        ? `rt team manage-membership: on for "${slug}" (invites grant forge read access)`
        : `rt team manage-membership: off for "${slug}"${record.createdByRt ? " (run `rt team manage-membership on` to let invites grant read access)" : " (mattstack did not create this repo, so it cannot be turned on)"}`,
    );
  } catch (err) {
    if (err instanceof UserActionableError) exitUserError(err, json, "team manage-membership", deps.print);
    throw err;
  }
}
```

- [ ] **Step 4: Register it in the command tree**

In `lib/command-tree-def.ts`, inside the `team` node's `subcommands`, after `invite`:

```ts
      "manage-membership": {
        description: "Let mattstack add and remove teammates' read access on a team repo it created",
        module: "./commands/team.ts",
        fn: "teamManageMembership",
        omitBehavior: "list",
        args: [
          { name: "State", type: "select", optional: true, hint: "Omit to show the current state", options: [{ value: "on", label: "on", hint: "invites grant forge read access" }, { value: "off", label: "off", hint: "invites print manual steps" }] },
          { name: "Team", flag: "--team", type: "text", placeholder: "acme", hint: "Which cloned team; omit when only one is cloned" },
          SETUP_JSON_ARG,
        ],
      },
```

In the same file, correct `invite`'s description, which currently claims a grant that only happens under the permission:

```ts
        description: "Mint an opaque invite code for a handle, granting forge read access where mattstack manages membership",
```

- [ ] **Step 5: Regenerate docs and run the conformance gate**

```bash
bun run docs:gen
bun run picker:check
bun test commands/__tests__/team.test.ts lib/__tests__/picker-conformance.test.ts
```
Expected: all PASS. `picker:check` failing here means the `optional: true` or `omitBehavior` above is wrong; fix it rather than the checker.

- [ ] **Step 6: Write the e2e test**

Create `e2e/tests/team-membership.test.ts`, following the shape of `e2e/tests/setup.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { runRt } from "../helpers.ts";

describe("rt team manage-membership", () => {
  test("an unknown state is a usage error at exit 2 with the envelope", async () => {
    const r = await runRt(["team", "manage-membership", "sideways", "--team", "acme", "--json"]);
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).failure.code).toBe("usage");
  });

  test("no local team is a user error, not a crash", async () => {
    const r = await runRt(["team", "manage-membership", "--json"]);
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).failure.code).toBe("no-team");
  });
});
```

Match `runRt`'s real name and import path from the existing e2e tests.

- [ ] **Step 7: Run e2e**

Run: `bun test --preload ./e2e/setup.ts --timeout 60000 e2e/tests/team-membership.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add commands/team.ts lib/command-tree-def.ts commands/__tests__/team.test.ts e2e/tests/team-membership.test.ts docs
git commit -m "team: add manage-membership verb; correct invite's description"
```

---

### Task 5: The invite command's offer and its early refusal

**Files:**
- Modify: `commands/team.ts:217-245` (`teamInvite`)
- Test: `commands/__tests__/team.test.ts`

**Interfaces:**
- Consumes: `readTeamLocal`/`updateTeamLocal` (Task 1); the three-way gate (Task 3).
- Produces: no new exports. `TeamDeps` gains two optional seams: `confirm?: (message: string) => Promise<boolean>` and `interactive?: () => boolean`.

**Why the refusal must be early:** `mintInvite` seals a pointer, POSTs it to the relay, and persists the local invite record before it calls `addToRoster`. A guard at the roster write would leave a live redeemable invite on the relay with no local record to revoke it. Refuse before the relay client is constructed.

- [ ] **Step 1: Write the failing tests**

```ts
test("a joined machine refuses before the relay is ever touched", async () => {
  let relayCalls = 0;
  const deps = inviteDeps({ record: { createdByRt: false, joinedByRt: true, rtMayManageMembership: false }, onRelay: () => { relayCalls++; } });

  await teamInvite(["--handle", "zaphod", "--team", "acme", "--json"], {}, deps);

  expect(relayCalls).toBe(0);
  expect(deps.exitCode).toBe(2);
  expect(JSON.parse(deps.lines[0]!).failure.code).toBe("team-pull-only");
});

test("on a TTY, accepting the offer writes the permission before minting", async () => {
  const deps = inviteDeps({ record: { createdByRt: true, joinedByRt: false, rtMayManageMembership: false } });
  deps.interactive = () => true;
  deps.confirm = async () => true;

  await teamInvite(["--handle", "zaphod", "--team", "acme"], {}, deps);

  expect(readTeamLocal(deps.probes, "acme").rtMayManageMembership).toBe(true);
});

test("--json never prompts, even on a TTY", async () => {
  const deps = inviteDeps({ record: { createdByRt: true, joinedByRt: false, rtMayManageMembership: false } });
  deps.interactive = () => true;
  let asked = false;
  deps.confirm = async () => { asked = true; return true; };

  await teamInvite(["--handle", "zaphod", "--team", "acme", "--json"], {}, deps);

  expect(asked).toBe(false);
  expect(readTeamLocal(deps.probes, "acme").rtMayManageMembership).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test commands/__tests__/team.test.ts -t teamInvite`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add the two seams to `TeamDeps`:

```ts
  /** The rt-ui confirm, seamed so a test never spawns the helper. */
  confirm?: (message: string) => Promise<boolean>;
  /** The TTY gate, seamed for the same reason. */
  interactive?: () => boolean;
```

In `teamInvite`, after `const slug = resolveTeamSlug(args);` and before `createRelayClient`:

```ts
    const local = readTeamLocal(deps.probes, slug);
    if (local.joinedByRt) {
      throw new UserActionableError(
        "team-pull-only",
        `this machine joined "${slug}" by invite, so its clone is pull-only and cannot add members or write team settings. Ask the team's owner to invite ${handle}. Member-proposed changes are tracked in MAT-415.`,
      );
    }

    // Asked here, not inside mintInvite: the mint POSTs to the relay before it
    // reaches the roster, so a question answered later would arrive after the
    // world had already changed.
    const gate = deps.interactive ?? (await import("../lib/ui/gate.ts")).interactive;
    if (!json && local.createdByRt && !local.rtMayManageMembership && gate()) {
      const ask = deps.confirm ?? (async (message: string) => (await import("../lib/ui/prompts.ts")).confirm({ message }));
      if (await ask(`mattstack created this repo. Let it give ${handle} read access on the forge, and manage access for future invites?`)) {
        updateTeamLocal(deps.probes, slug, { rtMayManageMembership: true });
      }
    }
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test commands/__tests__/team.test.ts`
Expected: PASS, including the pre-existing `--json` envelope test once you have updated its `manualSteps` length assertion at line 258 (it asserts `toHaveLength(1)`; the default fake is now the not-created branch, whose steps are the forge page plus the admin sentence). Update the number to match what the branch actually produces and keep the `"Ask whoever administers"` substring assertion.

- [ ] **Step 5: Commit**

```bash
git add commands/team.ts commands/__tests__/team.test.ts
git commit -m "team invite: offer the permission on a TTY, refuse on a joined machine before the relay"
```

---

### Task 6: Pull-only mode in the snapshot engine

**Files:**
- Modify: `lib/daemon/home-snapshot.ts:52-58` (`SkipReason`), `:80-102` (`SnapshotStatus`), `:145-158` (`SnapshotSpec`), the `doRun` guard region near `:978`, `doPushInner` at `:838`
- Test: `lib/daemon/__tests__/home-snapshot.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SnapshotSpec.pullOnly?: boolean`; `SnapshotStatus.pullOnly: boolean`; `SkipReason` gains `"pull-only"`. Task 7 sets the spec field; Task 8's `team.sync` row reads the status field.

**The contract:** pull-only means no commit **and** no push. Not push suppression. A clone that commits and never pushes grows ahead of origin, turns every pull into a rebase, and parks on a conflict its owner cannot resolve. A clean tree keeps fast-forward always sufficient.

- [ ] **Step 1: Write the failing tests**

In `lib/daemon/__tests__/home-snapshot.test.ts`, inside the existing `describe("startSnapshot: pull")` block (around line 2157), following that block's harness:

```ts
test("a pull-only spec fetches and fast-forwards but never commits or pushes", async () => {
  const h = startSnapshot({ ...teamSpecFixture(), pullOnly: true }, deps);
  await h.ready;

  await h.pullNow();
  await h.runNow("watch");

  expect(execArgs().some((a) => a.includes("fetch"))).toBe(true);
  expect(execArgs().some((a) => a.includes("commit"))).toBe(false);
  expect(execArgs().some((a) => a.includes("push"))).toBe(false);
  expect(h.status().pullOnly).toBe(true);
});

test("a pull-only spec reports its skip reason rather than looking idle", async () => {
  const h = startSnapshot({ ...teamSpecFixture(), pullOnly: true }, deps);
  await h.ready;

  const run = await h.runNow("watch");

  expect(run.skipped).toBe("pull-only");
});

test("a spec without pullOnly is unchanged and still commits and pushes", async () => {
  const h = startSnapshot(teamSpecFixture(), deps);
  await h.ready;

  await h.runNow("watch");

  expect(execArgs().some((a) => a.includes("commit"))).toBe(true);
  expect(h.status().pullOnly).toBe(false);
});
```

Reuse the fixture builder and exec-recording helper the surrounding tests already use rather than inventing new ones; `teamSpecFixture()` above stands for whatever that block calls it.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test lib/daemon/__tests__/home-snapshot.test.ts -t "pull-only"`
Expected: FAIL, `pullOnly` is not a spec field.

- [ ] **Step 3: Add the types**

In `lib/daemon/home-snapshot.ts`, add to the `SkipReason` union at line 52:

```ts
  | "pull-only"
```

Add to `SnapshotSpec` after `pull`:

```ts
  /**
   * This machine may not write the remote, so the engine only fetches and
   * fast-forwards: no commit, no push. A clean tree is what keeps
   * fast-forward always sufficient, so a member can never reach the rebase
   * conflict path at all.
   */
  pullOnly?: boolean;
```

Add to `SnapshotStatus` after `conflicted`:

```ts
  /** True when this clone only fetches and fast-forwards. */
  pullOnly: boolean;
```

- [ ] **Step 4: Add the two guards and the status field**

In `doRun`, immediately after the `if (conflicted)` guard (around line 978):

```ts
    if (spec.pullOnly) {
      return { committed: false, sha: null, paths: [], reason, skipped: "pull-only" };
    }
```

In `doPushInner`, immediately after the `enabled === false` guard (around line 850):

```ts
    // Backstop. A pull-only spec never commits, so nothing should ever arm a
    // push, but the timer is armed from more than one place and this costs
    // nothing.
    if (spec.pullOnly) return;
```

In the `status()` builder, add `pullOnly: spec.pullOnly === true`.

- [ ] **Step 5: Run to verify they pass**

Run: `bun test lib/daemon/__tests__/home-snapshot.test.ts`
Expected: PASS, the whole file. Other tests in it construct `SnapshotStatus` expectations; add `pullOnly: false` wherever a whole-status literal is compared.

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/home-snapshot.ts lib/daemon/__tests__/home-snapshot.test.ts
git commit -m "snapshot: pull-only mode, no commit and no push"
```

---

### Task 7: The supervisor computes and recomputes the mode

**Files:**
- Modify: `lib/daemon/team-snapshots.ts:127-165` (`rescan`)
- Test: `lib/daemon/__tests__/team-snapshots.test.ts`

**Interfaces:**
- Consumes: `SnapshotSpec.pullOnly` (Task 6); `readTeamLocal` (Task 1).
- Produces: no new exports.

**The bug this closes:** `rescan()` currently short-circuits with `if (instances.has(slug)) continue;` at line 141. A spec is therefore built once and never revisited, so an engine that started in push mode stays in push mode until the daemon restarts. Task 1's ordering fix closes the common race; this closes the class, including a hand-edited record.

- [ ] **Step 1: Write the failing tests**

In `lib/daemon/__tests__/team-snapshots.test.ts`:

```ts
test("a joined clone starts pull-only", async () => {
  writeTeamLocal(probes, "acme", { createdByRt: false, joinedByRt: true, rtMayManageMembership: false });
  const h = startTeamSnapshots(deps);
  await h.ready;

  expect(startedSpecs().find((s) => s.id === "team:acme")?.pullOnly).toBe(true);
});

test("an owner clone is not pull-only", async () => {
  writeTeamLocal(probes, "acme", { createdByRt: true, joinedByRt: false, rtMayManageMembership: false });
  const h = startTeamSnapshots(deps);
  await h.ready;

  expect(startedSpecs().find((s) => s.id === "team:acme")?.pullOnly).toBeFalsy();
});

test("a clone with no record at all keeps pushing, so nothing existing goes inert", async () => {
  const h = startTeamSnapshots(deps);
  await h.ready;

  expect(startedSpecs().find((s) => s.id === "team:acme")?.pullOnly).toBeFalsy();
});

test("a record that changes under a running daemon restarts the instance in the new mode", async () => {
  const h = startTeamSnapshots(deps);
  await h.ready;
  expect(startedSpecs().at(-1)?.pullOnly).toBeFalsy();

  writeTeamLocal(probes, "acme", { createdByRt: false, joinedByRt: true, rtMayManageMembership: false });
  await h.rescan();

  expect(startedSpecs().at(-1)?.pullOnly).toBe(true);
  expect(stoppedIds()).toContain("team:acme");
});
```

Use the file's existing fake `start` seam to record specs; `startedSpecs()`/`stoppedIds()` stand for the recorders it already has or that you add alongside them.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test lib/daemon/__tests__/team-snapshots.test.ts -t "pull-only"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `lib/daemon/team-snapshots.ts`, import `readTeamLocal` from `../team/team-local.ts`, and add above `rescan`:

```ts
/** A clone that arrived by redeeming an invite does not write the remote. Absent record means false, so nothing that predates the field changes behavior. */
function pullOnlyFor(slug: string): boolean {
  return readTeamLocal(probes, slug).joinedByRt;
}
```

Replace the short-circuit at line 141:

```ts
        const pullOnly = pullOnlyFor(slug);
        const running = instances.get(slug);
        if (running) {
          // The mode is a fact about the machine, and the record can change
          // under a running daemon (a join, a hand edit). Re-spec rather than
          // leaving a member pushing until someone restarts the daemon.
          if (running.pullOnly === pullOnly) continue;
          running.handle.stop();
          instances.delete(slug);
          rawDeps.log.info({ slug, pullOnly }, "team-snapshots: mode changed; restarting");
        }
```

Pass the field into the spec and record it on the instance:

```ts
        const spec = teamSnapshotSpec(slug, dir, { pullIntervalSec: clampPullIntervalSec(s.pullIntervalSec), originUrl, probes, pullOnly });
```

```ts
        instances.set(slug, { handle, dir, pullOnly });
```

Widen the instance map's value type to `{ handle: SnapshotHandle; dir: string; pullOnly: boolean }`.

In `lib/daemon/home-snapshot.ts`, thread the option through `teamSnapshotSpec`:

```ts
  opts: { pullIntervalSec: number; originUrl: string; probes: Probes; pullOnly?: boolean; readToken?: (p: Probes, remote: string) => Promise<string | null> },
```

and add `pullOnly: opts.pullOnly === true,` to the returned spec.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test lib/daemon`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/daemon
git commit -m "team-snapshots: compute pull-only per clone and recompute it per rescan"
```

---

### Task 8: The honest surfaces

**Files:**
- Modify: `lib/setup/validators/access.ts:70`, `lib/setup/validators/rt-health.ts:473-544`, `commands/team.ts` (`teamStatus`'s sync fields, around `:419-434`)
- Test: `lib/setup/__tests__/validators-access.test.ts`, `lib/setup/__tests__/validators-rt-health.test.ts`, `commands/__tests__/team-status.test.ts`

**Interfaces:**
- Consumes: `SnapshotStatus.pullOnly` (Task 6), surfaced through `TeamSnapshotEntry`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

```ts
// validators-rt-health.test.ts
test("a pull-only clone that is up to date is ready, and says why it never pushes", async () => {
  const r = await teamSyncRow(ctxWithEntries([{ slug: "acme", ...freshEntry(), pullOnly: true }]));
  expect(r.status).toBe("ready");
  expect(r.detail).toContain("pull-only");
});

test("a pull-only clone that cannot fast-forward is needs-you, and is never reset", async () => {
  const r = await teamSyncRow(ctxWithEntries([{ slug: "acme", ...freshEntry(), pullOnly: true, lastPullSkipped: "local changes would be overwritten by merge" }]));
  expect(r.status).toBe("needs-you");
  expect(r.detail).toContain("acme");
});

// validators-access.test.ts
test("the team repo row asks only for read on a pull-only clone", async () => {
  const r = await teamRepoRow(...withPullOnlyClone());
  expect(r.why).toContain("read");
  expect(r.why).not.toContain("read/write");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test lib/setup/__tests__/validators-rt-health.test.ts lib/setup/__tests__/validators-access.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `lib/setup/validators/access.ts:70`, split the `why` by mode. The row already receives the team snapshot; read the pull-only fact the same way the health row does, and use:

```ts
    why: pullOnly
      ? "rt needs read access to your team's home repo to sync settings and packs. Only the team's owner writes it."
      : "rt needs read/write access to your team's home repo to sync settings and packs.",
```

In `lib/setup/validators/rt-health.ts`, inside `teamSyncRow`'s per-entry loop, before the `lastPushError` check at line 516 (a pull-only clone has no push to fail):

```ts
    if (e.pullOnly) {
      if (e.lastPullSkipped) {
        problems.push(`${slug}: pull-only clone cannot fast-forward (${e.lastPullSkipped}); reset it to origin or ask the team's owner`);
      }
      continue;
    }
```

and include a `pull-only` note in the ready detail so an owner reading a member's machine understands the silence.

In `commands/team.ts`'s status reducer, carry `pullOnly` through into the printed and JSON output.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test lib/setup commands/__tests__/team-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/setup commands/team.ts commands/__tests__ lib/setup/__tests__
git commit -m "setup: report pull-only honestly in team.sync, access.team-repo and team status"
```

---

### Task 9: Refuse team-scope settings writes on a joined machine

**Files:**
- Create: `packages/rt-client/src/settings/team-local-read.ts`
- Modify: `packages/rt-client/src/settings/paths.ts`, `packages/rt-client/src/settings/write.ts:192` and `:212-231` and `:240-255`
- Test: `packages/rt-client/test/settings-write.test.ts` (or the file that already covers `resolveStorePath`)

**Interfaces:**
- Consumes: the on-disk record from Task 1.
- Produces: `export function isJoinedTeam(team: string): boolean` from `team-local-read.ts`; `export function teamLocalPath(team: string): string` from `paths.ts`.

**Both resolvers.** `setSetting` uses `resolveStorePath`; `unsetSetting` uses a separate `resolveStorePathForUnset` (called at `:192`, defined `:240-255`). Guarding only the first leaves `rt settings unset --scope team` open, and an unset is the same tracked-file mutation by a different verb.

**Mirror, do not import.** `paths.ts` documents that rt-client has no dependency on rt's `lib/` and that these literals are mirrored. Follow that, and say so in the comment.

- [ ] **Step 1: Write the failing tests**

```ts
test("set refuses a team write on a joined clone", () => {
  seedJoinedTeam("acme");
  expect(() => setSetting("board.title", "x", "team", { team: "acme" })).toThrow(/pull-only/);
});

test("unset refuses on a joined clone too", () => {
  seedJoinedTeam("acme");
  expect(() => unsetSetting("board.title", "team", { team: "acme" })).toThrow(/pull-only/);
});

test("an owner clone is unaffected", () => {
  seedOwnerTeam("acme");
  expect(() => setSetting("board.title", "x", "team", { team: "acme" })).not.toThrow();
});

test("a clone with no record at all is unaffected", () => {
  seedTeamWithNoRecord("acme");
  expect(() => setSetting("board.title", "x", "team", { team: "acme" })).not.toThrow();
});

test("user and machine scope are never gated by a team record", () => {
  seedJoinedTeam("acme");
  expect(() => setSetting("board.title", "x", "user", {})).not.toThrow();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/rt-client`
Expected: FAIL, no refusal.

- [ ] **Step 3: Mirror the path**

In `packages/rt-client/src/settings/paths.ts`, beside `teamSettingsPath`:

```ts
/** ~/.mattstack/rt/teams/<team>.json, the machine-local team record. Mirrored from repo-tools/lib/team/team-local.ts's teamLocalPath, which is the authority. */
export function teamLocalPath(team: string): string {
  return join(home(), ".mattstack", "rt", "teams", `${team}.json`);
}
```

- [ ] **Step 4: Write the reader**

Create `packages/rt-client/src/settings/team-local-read.ts`:

```ts
/**
 * One field of the machine-local team record, for the write guard. The record
 * itself is owned by repo-tools/lib/team/team-local.ts; this reads only what
 * the guard needs and never writes.
 */

import { readFileSync } from "fs";
import { teamLocalPath } from "./paths.ts";

/** Unreadable, absent or malformed all read as false, so nothing that predates the field is refused. */
export function isJoinedTeam(team: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(teamLocalPath(team), "utf8"));
    return typeof parsed === "object" && parsed !== null && (parsed as { joinedByRt?: unknown }).joinedByRt === true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Guard both resolvers**

In `write.ts`, add above `resolveStorePath`:

```ts
/**
 * A clone that arrived by redeeming an invite is pull-only, so a write here
 * would never reach the team AND would leave a tracked file dirty, which is
 * enough on its own to make the daemon's fast-forward pull fail.
 */
function refuseIfJoined(team: string): void {
  if (isJoinedTeam(team)) {
    refuse(
      `this machine joined "${team}" by invite, so its clone is pull-only and team settings cannot be written here. Ask the team's owner to make this change. Member-proposed changes are tracked in MAT-415.`,
    );
  }
}
```

Call it in **both** functions, in each of the two branches that resolve a team, immediately before returning the path: after the explicit `opts.team` branch resolves, and after the single-local-team branch picks `teams[0]`.

- [ ] **Step 6: Run the tests, then rebuild dist**

```bash
bun test packages/rt-client
cd packages/rt-client && bun run build && cd ../..
bun test packages/rt-client/test/dist-freshness.test.ts
```
Expected: all PASS. The dist rebuild is required, not optional: `file:` consumers copy `dist/` verbatim.

- [ ] **Step 7: Assert the variations degrade, without changing it**

`lib/variations.ts:96` already wraps the write in try/catch. Prove it:

```ts
test("saveVariation degrades to a structured failure on a joined clone, never a crash", () => {
  seedJoinedTeam("acme");
  const r = saveVariation(IDENTITY, ROOT, PKG, "build", VARIATION);
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("write-failed");
});
```

- [ ] **Step 8: Commit**

```bash
git add packages/rt-client lib/__tests__ lib/variations.ts
git commit -m "rt-client: refuse team settings writes on a pull-only clone, set and unset"
```

---

### Task 10: The four non-settings guards

**Files:**
- Modify: `lib/team/publish.ts`, `lib/team/members.ts` (both `membersSync` and `membersRemove`), `lib/secrets/team-store.ts` (`writeTeamSecret`), `lib/setup/steps/secrets.ts` (`secretsWriteRun`)
- Test: `lib/team/__tests__/publish.test.ts`, `lib/team/__tests__/members.test.ts`, `lib/secrets/__tests__/team-store.test.ts`, `lib/setup/__tests__/steps-secrets.test.ts`

**Interfaces:**
- Consumes: `readTeamLocal` (Task 1).
- Produces: no new exports. All four throw `UserActionableError("team-pull-only", ...)`.

**The Install trap, and why the guard is where it is.** `secretsWriteRun` drains staged secrets into the team store, and a joiner runs the full Install checklist. The guard goes inside `writeTeamSecret`, the real choke point, and the step catches it and returns `{ state: "skipped", detail }`. `StepOutcome` already has a `skipped` state (`lib/setup/apply.ts:25`). Guarding only the `rt secrets` CLI verb would leave Install writing a tracked file on a pull-only clone, which is exactly the jam this part exists to prevent.

- [ ] **Step 1: Write the failing tests**

```ts
// publish.test.ts
test("publish refuses on a joined clone", async () => {
  const p = probesWithJoinedTeam("acme");
  await expect(publishTeam(p, "acme", null)).rejects.toThrow(/pull-only/);
});

// members.test.ts
test("members sync refuses on a joined clone", async () => {
  await expect(membersSync(probesWithJoinedTeam("acme"), secrets, "acme", seams)).rejects.toThrow(/pull-only/);
});

test("members remove refuses on a joined clone", async () => {
  await expect(membersRemove(probesWithJoinedTeam("acme"), secrets, "acme", "zaphod", undefined, seams)).rejects.toThrow(/pull-only/);
});

// team-store.test.ts
test("writeTeamSecret refuses on a joined clone", async () => {
  await expect(writeTeamSecret("acme", "rt", "k", "v", seamsForJoined("acme"))).rejects.toThrow(/pull-only/);
});

// steps-secrets.test.ts
test("a staged team secret on a joined machine skips the step instead of failing Install", async () => {
  const outcome = await secretsWriteRun(ctxWithStagedTeamSecret("acme"));
  expect(outcome.state).toBe("skipped");
  expect(outcome.detail).toContain("pull-only");
});
```

Match each file's existing helper names and call signatures; the calls above show the arity, not necessarily the exact fixture names.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test lib/team lib/secrets lib/setup/__tests__/steps-secrets.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the three throwing guards**

Add to `lib/team/team-local.ts` (it already owns the record, so the shared sentence belongs with it):

```ts
/** The one refusal every owner-shaped team verb raises on a joined machine, so the wording cannot drift between them. */
export function assertNotJoined(p: Pick<Probes, "readFile" | "home">, slug: string): void {
  if (!readTeamLocal(p, slug).joinedByRt) return;
  throw new UserActionableError(
    "team-pull-only",
    `this machine joined "${slug}" by invite, so its clone is pull-only. Ask the team's owner to make this change. Member-proposed changes are tracked in MAT-415.`,
  );
}
```

Call `assertNotJoined(p, slug)` at the top of `publishTeam` (after `validateSlug`), `membersSync`, and `membersRemove`.

- [ ] **Step 4: Implement the secrets guard and the step's catch**

In `lib/secrets/team-store.ts`, call the same assertion at the top of `writeTeamSecret`. In `lib/setup/steps/secrets.ts`'s `secretsWriteRun`, catch it:

```ts
    if (err instanceof UserActionableError && err.code === "team-pull-only") {
      return { state: "skipped", detail: `${err.message} Nothing was written.` };
    }
```

placed with the existing `NoAgeKeyError` branch, before the generic handler.

- [ ] **Step 5: Run to verify they pass**

Run: `bun test lib commands packages scripts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib
git commit -m "team: refuse publish, members and team secret writes on a pull-only clone"
```

---

### Task 11: Full verification sweep

**Files:** none changed unless a gate fails.

- [ ] **Step 1: Run every gate the job requires**

```bash
bun run test:all
bunx tsc --noEmit
bun run docs:check
bun run picker:check
bash scripts/repo-purity.sh
```

All five must pass. The baseline before this work was green (6253 pass / 0 fail unit, 83 pass / 0 fail e2e), so any red is from this branch.

- [ ] **Step 2: If docs:check fails**

Run `bun run docs:gen`, review the diff, and commit it. Do not hand-edit generated reference pages.

- [ ] **Step 3: Confirm the rt-client dist is fresh**

```bash
bun test packages/rt-client/test/dist-freshness.test.ts
```
That test names its own fix in the failure message. Treat a failure as a real instruction.

- [ ] **Step 4: Commit any gate fixes**

```bash
git add -A
git commit -m "verification: green across test:all, tsc, docs, picker and purity"
```

---

## Self-Review

**Spec coverage.** Part A: Tasks 2, 3, 4, 5. Part B: Tasks 1, 6, 7, and the surfaces in 8. Part C: Tasks 9 and 10, covering all nine inventory rows (settings set and unset and the settings-kit HTTP surface all funnel through the two resolvers in Task 9; invite is Task 5's early refusal; publish, members, secrets are Task 10; variations is asserted in Task 9 Step 7; the VSCode extension's import reaches the same guarded resolver and needs no separate change). Non-goals are respected: no branch protection code anywhere, no GitLab create path, no capability probe, no `SCHEMA_VERSION`, no publish.

**Type consistency.** `joinedByRt` is spelled identically in Tasks 1, 5, 7, 9, 10. `pullOnly` is the spec field, the status field, and the supervisor's local, spelled identically in Tasks 6, 7, 8. The refusal code is `team-pull-only` in Tasks 5, 9, 10. `assertNotJoined` is defined once, in Task 10 Step 3, and used three times there plus once in Task 10 Step 4.

**Known softness, deliberate.** Several test snippets name a fixture helper generically (`teamSpecFixture`, `startedSpecs`, `probesForRedeem`) because the surrounding test file already has an equivalent under its own name. Each such step says to use the file's existing helper. That is a real instruction, not a placeholder: inventing a parallel harness beside an existing one is the wrong move in these files.
