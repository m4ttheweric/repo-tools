# Invite delivery and the joiner's forge-auth preflight ... Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an invite reach a teammate as a link they can click, and tell a joiner their forge account cannot see the team repo before the clone fails.

**Architecture:** rt mints `https://mattstack.dev/join#<code>` and leads with it in the paste block, the CLI output, and the Settings Team pane (copy link, share sheet). On the joiner's side one probe, `probeTeamRepoAccess`, backs both `rt team join --dry-run` and the `access.team-repo` checklist row, so they cannot disagree; its verdicts warn at Team Continue and gate at the checklist. One extractor accepts a bare code, the `mattstack://join/<code>` deep link, and any join-page URL, and a Paste-invite button reads the clipboard only on click.

**Tech Stack:** Bun + TypeScript (rt CLI), Swift 6 / SwiftUI (`rt-tray`, packages `MattstackCore` and the `rt-tray` executable), `bun:test`, the repo's own `Check` harness for Swift.

**Spec:** `docs/superpowers/specs/2026-09-07-invite-delivery-and-forge-preflight-design.md`

## Global Constraints

- **The TypeScript CLI is UI-free.** No JSX, no `.tsx`, no UI framework imports under `commands/`, `lib/`, `scripts/`. Enforced by `lib/__tests__/no-ui-in-cli.test.ts`.
- **Never rebuild, re-sign, or reinstall an app bundle macOS has blessed.** Do not run `rt-tray/build.sh`. Swift work is verified with `swift test --package-path rt-tray`, which builds into `.build/` only.
- **A built rt binary is only ever run under an isolated HOME.** This plan needs no built binary; do not create one.
- **Clean-code comments.** A comment earns its place only by stating a constraint the code cannot show. No narration, no review-facing notes, no ticket numbers in source.
- **No em dashes or en dashes** anywhere, including code comments and commit messages. Use "..." or rephrase.
- **The token reaches git through the inline credential helper only** (`lib/team/git-credential.ts`), never argv, never the URL.
- **rt reports access, it never grants it.** Denial copy names the owner or org admin. Nothing in this plan writes team scope or pushes the team repo.
- **The invite code never reaches a log.** `TrayLog` records that an invite was pasted, never its value.
- Invite code shape: 16 id bytes + 32 key bytes, Crockford base32 (no I/L/O/U), **77 characters** once dashes and whitespace are stripped.
- Commit after every task.

**Fixture constants used throughout** (verified against `decodeCode` in this repo):

```
plain  0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABC
dashed 01234-56789-ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-89ABC-DEFGH-JKMNP-QRSTV-WXYZ0-12345-6789A-BC
```

---

### Task 1: The invite-code extractor and its shared fixture

Anywhere rt takes a pasted invite it takes a bare code, `mattstack://join/<code>`, or a join-page URL on any host. One function, one return form, one fixture that Swift will later read too.

**Files:**
- Modify: `lib/team/invite-crypto.ts` (add beside `normalizeCode`)
- Create: `lib/team/fixtures/invite-code-inputs.json`
- Modify: `commands/team.ts:61` (`defaultReadCode`)
- Test: `lib/team/__tests__/invite-crypto.test.ts`, `commands/__tests__/team.test.ts`

**Interfaces:**
- Produces: `extractInviteCode(input: string): string | null` from `lib/team/invite-crypto.ts`. Returns the normalized bare code (uppercase, no dashes or whitespace, `normalizeCode` folding applied) or null. Task 7 mirrors it in Swift against the same fixture.

- [ ] **Step 1: Write the fixture**

Create `lib/team/fixtures/invite-code-inputs.json`. One array; `expect: null` means the input is not a usable invite. Both the TypeScript and the Swift suites read this file, so it is the only place these shapes are listed.

```json
[
  { "why": "bare code, dashed as minted", "input": "01234-56789-ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-89ABC-DEFGH-JKMNP-QRSTV-WXYZ0-12345-6789A-BC", "expect": "0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABC" },
  { "why": "bare code, no dashes", "input": "0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABC", "expect": "0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABC" },
  { "why": "surrounding whitespace and a trailing newline survive a chat paste", "input": "  01234-56789-ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-89ABC-DEFGH-JKMNP-QRSTV-WXYZ0-12345-6789A-BC\n", "expect": "0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABC" },
  { "why": "typo folding: O reads as 0, I and L read as 1", "input": "O123456789ABCDEFGHJKMNPQRSTVWXYZO123456789ABCDEFGHJKMNPQRSTVWXYZO123456789ABC", "expect": "0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABC" },
  { "why": "the deep link the landing page copies", "input": "mattstack://join/01234-56789-ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-89ABC-DEFGH-JKMNP-QRSTV-WXYZ0-12345-6789A-BC", "expect": "0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABC" },
  { "why": "the link rt mints", "input": "https://mattstack.dev/join#01234-56789-ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-89ABC-DEFGH-JKMNP-QRSTV-WXYZ0-12345-6789A-BC", "expect": "0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABC" },
  { "why": "host-agnostic: a link minted under RT_JOIN_BASE_URL in the VM harness must round-trip", "input": "http://localhost:8788/join#0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABC", "expect": "0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABC" },
  { "why": "a join page with no code in the fragment", "input": "https://mattstack.dev/join", "expect": null },
  { "why": "a deep link with no code", "input": "mattstack://join/", "expect": null },
  { "why": "a link to somewhere else entirely", "input": "https://mattstack.dev/", "expect": null },
  { "why": "wrong deep-link host", "input": "mattstack://settings/team", "expect": null },
  { "why": "truncated code", "input": "01234-56789-ABCDE", "expect": null },
  { "why": "right length, characters outside the Crockford alphabet", "input": "U123456789ABCDEFGHJKMNPQRSTVWXYZU123456789ABCDEFGHJKMNPQRSTVWXYZU123456789ABC", "expect": null },
  { "why": "empty", "input": "   ", "expect": null }
]
```

- [ ] **Step 2: Write the failing tests**

Add to `lib/team/__tests__/invite-crypto.test.ts`:

```ts
import fixture from "../fixtures/invite-code-inputs.json";
import { extractInviteCode } from "../invite-crypto.ts";

describe("extractInviteCode", () => {
  for (const c of fixture as { why: string; input: string; expect: string | null }[]) {
    test(c.why, () => {
      expect(extractInviteCode(c.input)).toBe(c.expect);
    });
  }

  test("every accepted case decodes", () => {
    for (const c of fixture as { input: string; expect: string | null }[]) {
      if (c.expect === null) continue;
      expect(() => decodeCode(extractInviteCode(c.input)!)).not.toThrow();
    }
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `bun test lib/team/__tests__/invite-crypto.test.ts`
Expected: FAIL, `extractInviteCode is not a function`.

- [ ] **Step 4: Implement the extractor**

In `lib/team/invite-crypto.ts`, beside `normalizeCode`. Replace the literal `77` in `decodeCode` with `CODE_LENGTH` while you are here; the comment above it stays.

```ts
const CODE_LENGTH = 77;
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The URL shape is host-agnostic on purpose: a link minted under
 * RT_JOIN_BASE_URL carries the code in the same fragment, and anchoring this
 * to mattstack.dev would break the VM harness the override exists for.
 */
function codeFromUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol === "mattstack:") {
    if (url.host.toLowerCase() !== "join") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 1 ? parts[0]! : null;
  }
  return url.hash.startsWith("#") ? url.hash.slice(1) : null;
}

/** The bare code, whether it arrived bare, as a deep link, or as a join-page URL; null when the input holds no code-shaped value. */
export function extractInviteCode(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const normalized = normalizeCode(codeFromUrl(trimmed) ?? trimmed);
  if (normalized.length !== CODE_LENGTH) return null;
  return [...normalized].every((ch) => CROCKFORD_ALPHABET.includes(ch)) ? normalized : null;
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `bun test lib/team/__tests__/invite-crypto.test.ts`
Expected: PASS, every fixture case.

- [ ] **Step 6: Write the failing CLI test**

Add to `commands/__tests__/team.test.ts`. `defaultReadCode` is internal, so drive it the way the command does, through stdin.

```ts
test("team join --dry-run accepts a pasted deep link, and hands an unrecognized string on untouched", async () => {
  const seen: string[] = [];
  const deps = fakeTeamDeps({ joinDryRun: async (_p, _relay, code) => { seen.push(code); return okJoinResult(); } });

  await teamJoin(["--dry-run", "--json"], {}, withStdin(deps, JSON.stringify({ code: "mattstack://join/01234-56789-ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-89ABC-DEFGH-JKMNP-QRSTV-WXYZ0-12345-6789A-BC" })));
  expect(seen[0]).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABC");

  await teamJoin(["--dry-run", "--json"], {}, withStdin(deps, JSON.stringify({ code: "nope" })));
  expect(seen[1]).toBe("nope");
});
```

Match the existing helpers in that file rather than these names if they differ; the assertions are what matter.

- [ ] **Step 7: Run it and watch it fail**

Run: `bun test commands/__tests__/team.test.ts`
Expected: FAIL, the first assertion sees the raw deep link.

- [ ] **Step 8: Wire the CLI reader**

In `commands/team.ts`, `defaultReadCode` (line 61). Both callers of the extractor use the same null rule, so a malformed code still gets `decodeCode`'s own "invite code is the wrong length" rather than a new error invented here.

```ts
  const raw = parsed.code;
  return extractInviteCode(raw) ?? raw;
```

Apply the same `?? raw` to the interactive `promptSecret` branch.

- [ ] **Step 9: Run the tests**

Run: `bun test commands/__tests__/team.test.ts lib/team/__tests__/invite-crypto.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add lib/team/invite-crypto.ts lib/team/fixtures/invite-code-inputs.json lib/team/__tests__/invite-crypto.test.ts commands/team.ts commands/__tests__/team.test.ts
git commit -m "invite: one extractor for the bare code, the deep link and any join-page url"
```

---

### Task 2: The join link, the paste block, and the CLI print

**Files:**
- Modify: `lib/team/invite.ts` (`pasteBlock`, `InviteResult`, `mintInvite`)
- Modify: `commands/team.ts:236-245` (`teamInvite`'s non-JSON print)
- Create: `website/docs/reference/_partials/team/invite.mdx`
- Test: `lib/team/__tests__/invite.test.ts`, `commands/__tests__/team.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `DEFAULT_JOIN_BASE_URL`, `joinLinkBase(env: Record<string, string | undefined>): string`, `joinLink(base: string, code: string): string`, and `InviteResult.link: string`. Task 7 mirrors `link` into the Swift `InviteResult`.

- [ ] **Step 1: Write the failing tests**

In `lib/team/__tests__/invite.test.ts`:

```ts
const CODE = "01234-56789-ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-89ABC-DEFGH-JKMNP-QRSTV-WXYZ0-12345-6789A-BC";
const PLAIN = "0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABC";

test("joinLinkBase defaults to mattstack.dev and honours RT_JOIN_BASE_URL", () => {
  expect(joinLinkBase({})).toBe("https://mattstack.dev/join");
  expect(joinLinkBase({ RT_JOIN_BASE_URL: "http://localhost:8788/join" })).toBe("http://localhost:8788/join");
});

test("the code rides in the fragment and nowhere else", () => {
  const link = joinLink("https://mattstack.dev/join", CODE);
  expect(link).toBe(`https://mattstack.dev/join#${CODE}`);
  expect(new URL(link).search).toBe("");
});

test("the fragment satisfies the landing page's own validator", () => {
  const fragment = new URL(joinLink("https://mattstack.dev/join", CODE)).hash.slice(1);
  const normalized = fragment.replace(/[\s-]/g, "").toUpperCase();
  expect(normalized).toHaveLength(77);
  expect(normalized).toBe(PLAIN);
  expect(/^[0-9A-HJKMNP-TV-Z]+$/.test(normalized)).toBe(true);
});

test("the paste block leads with the link and keeps the deep link and the bare code", () => {
  const block = pasteBlock(CODE, { link: `https://mattstack.dev/join#${CODE}`, teamName: "Acme" });
  expect(block).toContain(`https://mattstack.dev/join#${CODE}`);
  expect(block).toContain(`mattstack://join/${CODE}`);
  expect(block).toContain(CODE);
  expect(block).toContain("Acme");
});
```

Also assert `link` on the `mintInvite` result in that file's existing mint test:

```ts
expect(result.link).toBe(`https://mattstack.dev/join#${result.code}`);
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test lib/team/__tests__/invite.test.ts`
Expected: FAIL, `joinLinkBase is not a function`.

- [ ] **Step 3: Implement**

In `lib/team/invite.ts`. The base URL mirrors `DEFAULT_INVITE_RELAY_URL` / `RT_INVITE_RELAY_URL` in `lib/team/relay-client.ts:12` rather than taking a settings key: same class of value, read only by rt, and the VM harness needs to point it elsewhere without a team store.

```ts
export const DEFAULT_JOIN_BASE_URL = "https://mattstack.dev/join";

export function joinLinkBase(env: Record<string, string | undefined>): string {
  return env.RT_JOIN_BASE_URL || DEFAULT_JOIN_BASE_URL;
}

/** The code lives in the fragment, so it never reaches the page's server. */
export function joinLink(base: string, code: string): string {
  return `${base}#${code}`;
}

export function pasteBlock(
  code: string,
  opts: { link: string; teamName: string; downloadUrl?: string },
): string {
  const downloadUrl = opts.downloadUrl ?? "https://github.com/m4ttstack/rt/releases/latest";
  return [
    `You have been invited to the ${opts.teamName} mattstack team.`,
    "",
    `  ${opts.link}`,
    "",
    "That page installs mattstack and hands the invite to the app.",
    `Already have mattstack? Open mattstack://join/${code}, or paste this code`,
    "into Setup -> Join a team:",
    "",
    code,
    "",
    `Download by hand: ${downloadUrl}`,
  ].join("\n");
}
```

Add `link: string` to `InviteResult`, and in `mintInvite` build it from the code it just encoded:

```ts
  const link = joinLink(joinLinkBase(p.env), code);
  return { code, link, expiresAt, pasteBlock: pasteBlock(code, { link, teamName: snapshot.name }), forgeAccess, manualSteps };
```

Use whatever `mintInvite` already holds for the team's display name and its env accessor; do not add a new probe seam for either.

`pasteBlock`'s second parameter changes from a bare `downloadUrl` string to an
options object, so update its call site in `mintInvite` and the existing
assertions in `lib/team/__tests__/invite.test.ts` that pass a URL positionally.
Run `grep -rn "pasteBlock(" --include="*.ts" lib commands` and convert every
hit.

- [ ] **Step 4: Run the tests**

Run: `bun test lib/team/__tests__/invite.test.ts`
Expected: PASS.

- [ ] **Step 5: Print the link in the CLI**

In `commands/team.ts`, `teamInvite`'s non-JSON branch, above the paste block:

```ts
    deps.print(result.link);
    deps.print("");
    deps.print(result.pasteBlock);
```

Add to `commands/__tests__/team.test.ts`:

```ts
test("team invite prints the join link on its own line", async () => {
  await teamInvite(["--handle", "bob"], {}, deps);
  expect(deps.lines[0]).toMatch(/^https:\/\/mattstack\.dev\/join#/);
});
```

- [ ] **Step 6: Write the docs partial**

Create `website/docs/reference/_partials/team/invite.mdx`. The generated page carries usage and flags only, so prose lives here; `gen-docs.ts:30` includes it by path.

```mdx
The link in the output is the thing to send. It opens a page that installs
mattstack and hands the invite to the app, and the code never leaves the URL
fragment, so it never reaches a server.

The code itself is the fallback for a chat client that mangles links: it can be
pasted into Setup -> Join a team by hand.
```

- [ ] **Step 7: Run the suite and the docs gate**

Run: `bun test lib commands && bun run docs:check`
Expected: PASS both. If `docs:check` reports a diff, run `bun run docs:gen` and commit the regenerated page.

- [ ] **Step 8: Commit**

```bash
git add lib/team/invite.ts lib/team/__tests__/invite.test.ts commands/team.ts commands/__tests__/team.test.ts website/docs/reference/_partials/team/invite.mdx website/docs/reference/team/invite.mdx
git commit -m "invite: mint the join link and lead with it in the paste block and the cli"
```

---

### Task 3: One forge-token lookup

Three readers implement stored-then-staged today and disagree about failure. One survivor, and it distinguishes "rt has no token" from "rt could not read its own store", because only the first licenses a `no-account` verdict later.

**Files:**
- Create: `lib/team/forge-token.ts`
- Modify: `lib/setup/steps/forge-token.ts:13`, `lib/team/stored-forge-token.ts:12`, `lib/setup/validators/access.ts:34`
- Test: `lib/team/__tests__/forge-token.test.ts`

**Interfaces:**
- Produces: `ForgeTokenLookup`, `ForgeTokenSeams`, `forgeTokenLookup(remote, seams)`, `tokenOrNull(lookup)`, `forgeTokenLookupFromPresence(remote, secrets)` and `forgeTokenLookupReal(p, remote)` from `lib/team/forge-token.ts`. Task 4 consumes `ForgeTokenLookup`; Task 5 calls `forgeTokenLookupFromPresence`, Task 6 calls `forgeTokenLookupReal`.

- [ ] **Step 1: Write the failing test**

`lib/team/__tests__/forge-token.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { NoAgeKeyError } from "../../secrets/store.ts";
import { forgeTokenLookup, tokenOrNull } from "../forge-token.ts";

const REMOTE = "https://github.com/acme/team.git";
const seams = (stored: () => Promise<string | null>, staged: string | null = null) => ({
  readStored: stored,
  readStaged: () => staged,
});

describe("forgeTokenLookup", () => {
  test("the store answers", async () => {
    expect(await forgeTokenLookup(REMOTE, seams(async () => "gho_stored"))).toEqual({ kind: "token", token: "gho_stored" });
  });

  test("no age key yet falls through to the stage", async () => {
    const lookup = await forgeTokenLookup(REMOTE, seams(async () => { throw new NoAgeKeyError("no key"); }, "gho_staged"));
    expect(lookup).toEqual({ kind: "token", token: "gho_staged" });
  });

  test("store and stage both empty is absent, which is what licenses no-account", async () => {
    expect(await forgeTokenLookup(REMOTE, seams(async () => null))).toEqual({ kind: "absent" });
  });

  test("a store failure that is not a missing key is unreadable, never absent", async () => {
    const lookup = await forgeTokenLookup(REMOTE, seams(async () => { throw new Error("sops exited 2"); }));
    expect(lookup.kind).toBe("unreadable");
    expect(tokenOrNull(lookup)).toBeNull();
  });

  test("a remote on no known forge is absent", async () => {
    expect(await forgeTokenLookup("https://example.com/x.git", seams(async () => "gho_stored"))).toEqual({ kind: "absent" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test lib/team/__tests__/forge-token.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`lib/team/forge-token.ts`:

```ts
/**
 * The one stored-then-staged read of rt's forge token. `absent` and
 * `unreadable` are kept apart because only `absent` is evidence that the user
 * has connected no account: a store rt cannot read says nothing about them.
 */

import { NoAgeKeyError } from "../secrets/store.ts";
import { forgeTokenKey } from "./git-credential.ts";

export type ForgeTokenLookup =
  | { kind: "token"; token: string }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string };

export interface ForgeTokenSeams {
  readStored: (domain: string, key: string) => Promise<string | null>;
  readStaged: (domain: string, key: string) => string | null;
}

export async function forgeTokenLookup(remote: string, seams: ForgeTokenSeams): Promise<ForgeTokenLookup> {
  const key = forgeTokenKey(remote);
  if (!key) return { kind: "absent" };
  try {
    const stored = await seams.readStored("rt", key);
    if (stored !== null) return { kind: "token", token: stored };
  } catch (err) {
    if (!(err instanceof NoAgeKeyError)) {
      return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
    }
  }
  const staged = seams.readStaged("rt", key);
  return staged === null ? { kind: "absent" } : { kind: "token", token: staged };
}

export function tokenOrNull(lookup: ForgeTokenLookup): string | null {
  return lookup.kind === "token" ? lookup.token : null;
}
```

Two adapters ship with it, so Tasks 5 and 6 never build seams by hand:

```ts
/** For the validators, whose SecretPresence seam already folds the stage in. */
export async function forgeTokenLookupFromPresence(remote: string, secrets: SecretPresence | undefined): Promise<ForgeTokenLookup> {
  if (!secrets) return { kind: "absent" };
  return forgeTokenLookup(remote, { readStored: (d, k) => secrets.has(d, k), readStaged: () => null });
}

/** For callers holding only Probes: the real store, then the pre-Install stage. */
export async function forgeTokenLookupReal(p: Probes, remote: string): Promise<ForgeTokenLookup> {
  return forgeTokenLookup(remote, {
    readStored: (d, k) => readSecret(d, k, { ageKeySeam: createRealAgeKeySeam(), execSeam: createRealSecretsExecSeam() }),
    readStaged: (d, k) => readStagedSecret(p, d, k),
  });
}
```

Import `SecretPresence` as a type from `lib/setup/validators/accounts.ts`, and the seams from `lib/home/age-key.ts`, `lib/secrets/store.ts` and `lib/setup/staging.ts`, matching what `stored-forge-token.ts` imports today. Add one test per adapter to the file above: presence-backed returns `token`, and the undefined-secrets case returns `absent` without calling anything.

- [ ] **Step 4: Run it and watch it pass**

Run: `bun test lib/team/__tests__/forge-token.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire the three readers onto it**

Each keeps its existing exported signature so no caller churns; only the body changes.

- `lib/setup/steps/forge-token.ts`: `forgeTokenFor(ctx, remote)` becomes `tokenOrNull(await forgeTokenLookup(remote, { readStored: (d, k) => readSecret(d, k, ctx.secrets), readStaged: (d, k) => readStagedSecret(ctx.p, d, k) }))`.
- `lib/team/stored-forge-token.ts`: `storedForgeToken(p, remote)` builds the same seams with the real age-key and exec seams plus `readStagedSecret(p, ...)`, then returns `tokenOrNull(...)`. It gains the stage it never had, which is the point: it runs pre-Install on the joiner's machine.
- `lib/setup/validators/access.ts`: delete the local `forgeTokenFor` and call `forgeTokenLookup` with `readStored: (d, k) => secrets.has(d, k)` and `readStaged: () => null` (the `SecretPresence` seam already folds the stage in). When `secrets` is undefined, use `{ kind: "absent" }` without calling anything.

- [ ] **Step 6: Run the affected suites**

Run: `bun test lib/setup lib/team`
Expected: PASS. Existing behavior is unchanged everywhere except that `storedForgeToken` now also sees staged values.

- [ ] **Step 7: Commit**

```bash
git add lib/team/forge-token.ts lib/team/__tests__/forge-token.test.ts lib/setup/steps/forge-token.ts lib/team/stored-forge-token.ts lib/setup/validators/access.ts
git commit -m "forge token: one stored-then-staged lookup that keeps absent and unreadable apart"
```

---

### Task 4: The repo-access probe

**Files:**
- Create: `lib/team/repo-access.ts`
- Test: `lib/team/__tests__/repo-access.test.ts`

**Interfaces:**
- Consumes: `ForgeTokenLookup` from Task 3.
- Produces: `RepoAccessVerdict` (`ok` | `no-clt` | `no-account` | `denied` | `unreachable` | `indeterminate`, each `{ kind, detail }`), `probeTeamRepoAccess(p: Probes, remote: string, lookup: ForgeTokenLookup): Promise<RepoAccessVerdict>` and `forgeLabel(provider)` from `lib/team/repo-access.ts`. Tasks 5 and 6 both consume it and must not classify git output themselves.

- [ ] **Step 1: Write the failing tests**

`lib/team/__tests__/repo-access.test.ts`:

```ts
import { describe, test, expect, beforeEach } from "bun:test";
import { probeTeamRepoAccess } from "../repo-access.ts";
import { resetCltCacheForTests } from "../../setup/home-git.ts";
import { fakeProbes, ok } from "../../setup/__tests__/fakes.ts";
import type { ExecScript } from "../../setup/__tests__/fakes.ts";

const REMOTE = "https://github.com/acme/team.git";
const ABSENT = { kind: "absent" } as const;
const TOKEN = { kind: "token", token: "gho_x" } as const;
const git = (script: ExecScript): ExecScript => (argv, opts) => (argv[0] === "xcode-select" ? ok() : script(argv, opts));

describe("probeTeamRepoAccess", () => {
  beforeEach(() => resetCltCacheForTests());

  test("exit 0 is ok", async () => {
    const v = await probeTeamRepoAccess(fakeProbes({ exec: git(() => ok()) }), REMOTE, TOKEN);
    expect(v.kind).toBe("ok");
  });

  test("exit 2 is an empty repo, still ok", async () => {
    const v = await probeTeamRepoAccess(fakeProbes({ exec: git(() => ({ code: 2, stdout: "", stderr: "" })) }), REMOTE, TOKEN);
    expect(v).toEqual({ kind: "ok", detail: "empty repo (will be initialized)" });
  });

  test("no Command Line Tools: git is never run", async () => {
    const seen: string[][] = [];
    const exec: ExecScript = (argv) => {
      seen.push(argv);
      return argv[0] === "xcode-select" ? { code: 2, stdout: "", stderr: "unable to get active developer directory" } : ok();
    };
    const v = await probeTeamRepoAccess(fakeProbes({ exec }), REMOTE, TOKEN);
    expect(v.kind).toBe("no-clt");
    expect(seen.some((argv) => argv[0] === "git")).toBe(false);
  });

  test("no credential offered and rt holds no token is no-account", async () => {
    const exec = git(() => ({ code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://github.com'" }));
    const v = await probeTeamRepoAccess(fakeProbes({ exec }), REMOTE, ABSENT);
    expect(v.kind).toBe("no-account");
  });

  test("no credential offered while rt DID hold a token is indeterminate, never no-account", async () => {
    const exec = git(() => ({ code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://github.com'" }));
    const v = await probeTeamRepoAccess(fakeProbes({ exec }), REMOTE, TOKEN);
    expect(v.kind).toBe("indeterminate");
  });

  test("an unreadable store is indeterminate and names the reason", async () => {
    const exec = git(() => ({ code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://github.com'" }));
    const v = await probeTeamRepoAccess(fakeProbes({ exec }), REMOTE, { kind: "unreadable", reason: "sops exited 2" });
    expect(v.kind).toBe("indeterminate");
    expect(v.detail).toContain("sops exited 2");
  });

  test("a refusal is denied", async () => {
    const exec = git(() => ({ code: 128, stdout: "", stderr: "remote: Permission denied fatal: Authentication failed" }));
    const v = await probeTeamRepoAccess(fakeProbes({ exec }), REMOTE, TOKEN);
    expect(v.kind).toBe("denied");
  });

  test("a timeout is unreachable", async () => {
    const v = await probeTeamRepoAccess(fakeProbes({ exec: git(() => ({ code: 124, stdout: "", stderr: "" })) }), REMOTE, TOKEN);
    expect(v.kind).toBe("unreachable");
  });

  test("the token reaches git through the credential helper, never argv or the url", async () => {
    const seen: string[][] = [];
    const envs: Record<string, string>[] = [];
    const exec: ExecScript = (argv, opts) => {
      if (argv[0] === "xcode-select") return ok();
      seen.push(argv);
      envs.push((opts?.env ?? {}) as Record<string, string>);
      return ok();
    };
    await probeTeamRepoAccess(fakeProbes({ exec }), REMOTE, TOKEN);
    expect(seen[0]!.join(" ")).not.toContain("gho_x");
    expect(envs[0]!.RT_GIT_TOKEN).toBe("gho_x");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test lib/team/__tests__/repo-access.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`lib/team/repo-access.ts`. Move `LS_REMOTE_TIMEOUT_MS`, `GIT_ENV`, `AUTH_REFUSAL_PATTERN` and `NO_CREDENTIAL_PATTERN` here from `lib/setup/validators/access.ts` (Task 5 deletes them there).

```ts
/**
 * The one read of what a joiner's credentials can see. `no-account` requires
 * both halves of the evidence: git had nothing to offer AND rt holds no token
 * of its own. Either alone is only a could-not-determine.
 */

import { gitUsable } from "../setup/home-git.ts";
import type { Probes } from "../setup/probes.ts";
import { gitWithToken } from "./git-credential.ts";
import { tokenOrNull, type ForgeTokenLookup } from "./forge-token.ts";
import { withoutUrls } from "./redact.ts";

export type RepoAccessVerdict = { kind: "ok" | "no-clt" | "no-account" | "denied" | "unreachable" | "indeterminate"; detail: string };

/** The user-facing name of a forge, from the provider rather than the host, so an unrecognized host never renders as the wrong one. Both the row copy and the join copy read it from here. */
export function forgeLabel(provider: "github" | "gitlab" | undefined): string {
  return provider === "gitlab" ? "GitLab" : "GitHub";
}

const LS_REMOTE_TIMEOUT_MS = 15000;
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };
const AUTH_REFUSAL_PATTERN = /Authentication failed|403|Permission denied/;
const NO_CREDENTIAL_PATTERN = /could not read Username/;

export async function probeTeamRepoAccess(p: Probes, remote: string, lookup: ForgeTokenLookup): Promise<RepoAccessVerdict> {
  // Without the Command Line Tools, git is the xcode-select shim: it fails and
  // raises Apple's install dialog on every probe.
  if (!(await gitUsable(p.exec))) {
    return { kind: "no-clt", detail: "needs Apple's Command Line Tools first" };
  }

  const cmd = gitWithToken(["ls-remote", "--exit-code", remote, "HEAD"], tokenOrNull(lookup), GIT_ENV);
  const res = await p.exec(cmd.argv, { timeoutMs: LS_REMOTE_TIMEOUT_MS, env: cmd.env });
  if (res.code === 0) return { kind: "ok", detail: "reachable" };
  if (res.code === 2) return { kind: "ok", detail: "empty repo (will be initialized)" };
  if (res.code === 128) {
    if (NO_CREDENTIAL_PATTERN.test(res.stderr)) {
      if (lookup.kind === "absent") return { kind: "no-account", detail: "no forge account connected yet" };
      const why = lookup.kind === "unreadable" ? `rt could not read its own token store: ${lookup.reason}` : "rt offered its token and git still had none to send";
      return { kind: "indeterminate", detail: `couldn't determine access: ${why}` };
    }
    if (AUTH_REFUSAL_PATTERN.test(res.stderr)) return { kind: "denied", detail: "the forge refused this account" };
  }
  if (res.code === 124) return { kind: "unreachable", detail: "unreachable: git ls-remote timed out" };
  const firstLine = withoutUrls(res.stderr.trim().split("\n")[0] || `exit ${res.code}`);
  return { kind: "unreachable", detail: `unreachable: ${firstLine}` };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test lib/team/__tests__/repo-access.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/team/repo-access.ts lib/team/__tests__/repo-access.test.ts
git commit -m "repo access: one probe with no-account and denied kept apart"
```

---

### Task 5: The checklist rows read the probe

`lsRemoteOutcome` is the second classifier of the same git output. Delete it; both rows map the probe's verdicts through one function.

**Files:**
- Modify: `lib/setup/validators/access.ts` (delete `lsRemoteOutcome` and its constants, rewrite `teamRepoRow` and `repoRow`)
- Test: `lib/setup/__tests__/validators-access.test.ts`

**Interfaces:**
- Consumes: `probeTeamRepoAccess` and `forgeLabel` (Task 4), `forgeTokenLookupFromPresence` (Task 3), `integrationDef` from `lib/setup/integrations.ts`.
- Produces: nothing new outside the module.

- [ ] **Step 1: Write the failing tests**

Add to `lib/setup/__tests__/validators-access.test.ts`:

```ts
test("no forge account connected -> needs-you with a Connect action, not an error nobody can act on", async () => {
  const team = baseTeam({ remote: REMOTE });
  const exec = gitAnswers(() => ({ code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://gitlab.example.com'" }));
  const r = await pickRow(accessRows(fakeProbes({ exec }), team, null, {}, { has: async () => null }), "access.team-repo");
  expect(r.status).toBe("needs-you");
  expect(r.detail).toContain("Connect your GitLab account");
  expect(r.action?.type).toBe("connect");
});

test("a refusal names who grants access and never promises rt will", async () => {
  const team = baseTeam({ remote: REMOTE });
  const exec = gitAnswers(() => ({ code: 128, stdout: "", stderr: "remote: Permission denied" }));
  const r = await pickRow(accessRows(fakeProbes({ exec }), team, joinIntent("matt"), {}, { has: async () => "glpat_x" }), "access.team-repo");
  expect(r.status).toBe("needs-you");
  expect(r.detail).toContain("ask matt");
  expect(r.detail).toContain("org admin");
  expect(r.detail).not.toContain("rt will");
});

test("rt held a token and git still had none: still an error, not a bogus no-account", async () => {
  const team = baseTeam({ remote: REMOTE });
  const exec = gitAnswers(() => ({ code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://gitlab.example.com'" }));
  const r = await pickRow(accessRows(fakeProbes({ exec }), team, null, {}, { has: async () => "glpat_x" }), "access.team-repo");
  expect(r.status).toBe("error");
  expect(r.detail).toContain("couldn't determine");
});
```

And one for the optional per-repo row, which has its own `grantedBy` and no team owner to name:

```ts
test("a tracked repo's row names that repo's admin, not the team owner", async () => {
  const team = baseTeam({ remote: REMOTE, trackingIdentities: ["github.com/acme/repo"] });
  const exec = gitAnswers(() => ({ code: 128, stdout: "", stderr: "remote: Permission denied" }));
  const r = await pickRow(accessRows(fakeProbes({ exec }), team, joinIntent("matt"), {}, { has: async () => "glpat_x" }), "access.repo.github.com-acme-repo");
  expect(r.required).toBe(false);
  expect(r.detail).toContain("that repo's admin");
  expect(r.detail).not.toContain("matt");
});
```

`joinIntent(owner)` builds a `SetupIntent` with `mode: "join"` and a pointer whose `remote` is `REMOTE` and whose `owner` is the argument; follow the intent shape the file already uses elsewhere.

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test lib/setup/__tests__/validators-access.test.ts`
Expected: FAIL, the first two see `status: "error"` with the old wording.

- [ ] **Step 3: Rewrite the rows**

Delete `lsRemoteOutcome`, `LsRemoteOutcome`, `LS_REMOTE_TIMEOUT_MS`, `GIT_ENV`, `AUTH_REFUSAL_PATTERN`, `NO_CREDENTIAL_PATTERN` and the now-unused `gitWithToken`, `withoutUrls` and `gitUsable` imports (`access.ts:11`, `:15`, `:16`) from `lib/setup/validators/access.ts`. `forgeTokenKey` goes with the local `forgeTokenFor` deleted in Task 3. Then:

```ts
/** Who the caller should ask. The team's owner for the team repo; a repo's own admin for a tracked repo, which has no owner rt knows. */
function rowFromVerdict(v: RepoAccessVerdict, ctx: { grantedBy: string; provider: "github" | "gitlab" }): Pick<Row, "status" | "detail" | "action"> {
  const forge = forgeLabel(ctx.provider);
  switch (v.kind) {
    case "ok":
      return { status: "ready", detail: v.detail, action: null };
    case "no-clt":
      return { status: "missing", detail: "needs Apple's Command Line Tools first (see the tool row), then re-check", action: RECHECK_ACTION };
    case "no-account":
      return { status: "needs-you", detail: `Connect your ${forge} account so rt can prove access`, action: { type: "connect", label: "Connect", integration: ctx.provider, fields: integrationDef(ctx.provider).fields } };
    case "denied":
      return { status: "needs-you", detail: `your ${forge} account cannot see this repo yet: ask ${ctx.grantedBy} or your org admin to grant read access`, action: RECHECK_ACTION };
    default:
      return { status: "error", detail: v.detail, action: RECHECK_ACTION };
  }
}
```

`teamRepoRow` keeps its `missing` branch for "no team remote yet (screen 2)", then:

```ts
  const provider = forgeFromRemote(remote)?.provider ?? "github";
  const verdict = await probeTeamRepoAccess(p, remote, await forgeTokenLookupFromPresence(remote, secrets));
  const grantedBy = intent?.join?.pointer.owner ?? team.integrations.forge?.host ?? "the repo's owner";
  return row({ ...base, ...rowFromVerdict(verdict, { grantedBy, provider }) });
```

`repoRow` probes unauthenticated exactly as it does today, so pass `{ kind: "absent" }` and let its own `grantedBy` be `"that repo's admin"`. Its `required: false` and its title, `why` and `optionalNote` do not change.

`repoRow` holds an identity string, not a remote, so derive the provider the
same way it builds the URL it probes:

```ts
  const remote = `https://${identity}.git`;
  const provider = forgeFromRemote(remote)?.provider ?? "github";
```

An identity on no known forge falls back to `github` for the label only; the
Connect action it offers is the one `account.github` offers, which is the
honest suggestion for an unknown host on an optional row.

Keep the CLT check in one place: the probe owns it now, so `teamRepoRow`'s own `gitUsable` call goes away.

- [ ] **Step 4: Run the tests**

One pre-existing test inverts and must be rewritten in this step, not worked
around: `lib/setup/__tests__/validators-access.test.ts:83` ("exit 128 with
'could not read Username' ... error, NOT a permissions verdict (finding 6)")
passes `accessRows(..., team, null)` with no `secrets`, which now yields
`absent` and therefore `no-account`, `needs-you` and a Connect action. Finding 6
is superseded only for the no-token case: its real point, that a missing
credential is never read as a refusal, still holds and is now carried by
Step 1's `indeterminate` test for the token-held case. Rewrite :83 to assert
`needs-you` plus the Connect action, and say in its name that no credential is
still not a refusal.

Run: `bun test lib/setup/__tests__/validators-access.test.ts`
Expected: PASS, including the pre-existing row-order test at line 320.

- [ ] **Step 5: Commit**

```bash
git add lib/setup/validators/access.ts lib/setup/__tests__/validators-access.test.ts
git commit -m "access rows: read the shared probe, and say connect your account instead of couldnt determine"
```

---

### Task 6: The join dry-run answers instead of deferring

**Files:**
- Modify: `lib/team/join.ts` (`JoinResult`, `joinDryRun`, and the message helpers)
- Test: `lib/team/__tests__/join.test.ts`

**Interfaces:**
- Consumes: `probeTeamRepoAccess` and `forgeLabel` (Task 4), `forgeTokenLookupReal` (Task 3).
- Produces: `JoinResult` with `access: "ok" | "deferred" | "no-account" | "denied" | "unreachable" | "undetermined"` and `intent: "written" | "not-written"`. Tasks 7 and 9 decode both.

- [ ] **Step 1: Write the failing tests**

In `lib/team/__tests__/join.test.ts`:

```ts
test("a denial writes the intent anyway, so Continue can proceed and the checklist holds the line", async () => {
  const p = fakeProbes({ exec: gitAnswers(() => ({ code: 128, stdout: "", stderr: "remote: Permission denied" })) });
  const r = await joinDryRun(p, relayWith(pointer), CODE);
  expect(r.access).toBe("denied");
  expect(r.intent).toBe("written");
  expect(r.message).toContain("ask matt");
  expect(readIntent(p)?.mode).toBe("join");
});

test("no forge account connected says so by name", async () => {
  const p = fakeProbes({ exec: gitAnswers(() => ({ code: 128, stdout: "", stderr: "fatal: could not read Username" })) });
  const r = await joinDryRun(p, relayWith(pointer), CODE);
  expect(r.access).toBe("no-account");
  expect(r.intent).toBe("written");
});

test("an unreachable relay writes nothing and still blocks", async () => {
  const p = fakeProbes({ exec: gitAnswers(() => ok()) });
  const r = await joinDryRun(p, unreachableRelay(), CODE);
  expect(r.access).toBe("unreachable");
  expect(r.intent).toBe("not-written");
  expect(readIntent(p)).toBeNull();
});

test("the probe is offered rt's token, so a private repo is a verdict rather than a deferral", async () => {
  const envs: Record<string, string>[] = [];
  const exec = gitAnswers((argv, opts) => { envs.push((opts?.env ?? {}) as Record<string, string>); return ok(); });
  // forgeTokenLookupReal reads the real sops store, which a test must not
  // touch, then the stage, which is plain probe-backed files. Stage it.
  const p = fakeProbes({
    exec,
    home: "/home/joiner",
    files: { "/home/joiner/.mattstack/rt/setup-staging/rt.json": JSON.stringify({ githubToken: "gho_x" }) },
  });
  await joinDryRun(p, relayWith(pointer), CODE);
  expect(envs.some((e) => e.RT_GIT_TOKEN === "gho_x")).toBe(true);
});
```

`FakeProbesOpts` (`lib/setup/__tests__/fakes.ts:13`) has no token option, and
`forgeTokenLookupReal` hardcodes the real age-key and exec seams by design, so
the stage is the injectable path. Do **not** add a token seam to `joinDryRun`:
the spec describes no such seam, and the staged read is the same path a real
joiner takes pre-Install. Use a `pointer.remote` on `github.com` so the staged
key matches, or stage `gitlabToken` to match whatever remote the file's fixture
pointer uses.

Follow the file's existing relay fakes and pointer builders; `CODE` is the dashed fixture constant.

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test lib/team/__tests__/join.test.ts`
Expected: FAIL, `intent` is undefined and a denial returns without writing.

- [ ] **Step 3: Rewrite `joinDryRun`**

```ts
export async function joinDryRun(p: Probes, relay: RelayClient, code: string): Promise<JoinResult> {
  const { idHex, key } = decodeCode(code);

  const pointer = await fetchPointer(relay, idHex, key);
  if (pointer === null) {
    return { ...unreachableResult(NO_TEAM, "could not reach the invite relay - check your network and try again"), intent: "not-written" };
  }

  const verdict = await probeTeamRepoAccess(p, pointer.remote, await forgeTokenLookupReal(p, pointer.remote));
  writeIntent(p, { v: 1, at: p.now().toISOString(), mode: "join", join: { id: idHex, keyB64: Buffer.from(key).toString("base64"), pointer } });
  return { team: teamRefFrom(pointer), ...accessFromVerdict(verdict, pointer), peering: "idle", intent: "written" };
}
```

`accessFromVerdict` is the one place the copy lives, and every verdict maps:

```ts
/** The row is the later check this copy promises, so unreachable and undetermined read as re-checked-later here and as an error there. */
function accessFromVerdict(v: RepoAccessVerdict, pointer: InvitePointer): { access: JoinResult["access"]; message: string } {
  const joining = `Joining ${pointer.name} (owner ${pointer.owner})`;
  // pointer.forge is a host, so deriving the label from it renders "GitLab"
  // for anything unrecognized. Both surfaces read it off the remote instead.
  const forge = forgeLabel(forgeFromRemote(pointer.remote)?.provider);
  const repo = stripUserinfo(pointer.remote);
  switch (v.kind) {
    case "ok":
      return { access: "ok", message: joining };
    case "no-clt":
      return { access: "deferred", message: `${joining} - access to the team repo is checked on the next screen` };
    case "no-account":
      return { access: "no-account", message: `${joining}. Connect your ${forge} account on the next screen so rt can reach ${repo}.` };
    case "denied":
      return { access: "denied", message: `${joining}. Your ${forge} account cannot see ${repo} yet: ask ${pointer.owner} or your org admin to grant read access.` };
    case "unreachable":
      return { access: "unreachable", message: `${joining}. Could not reach ${repo}: ${v.detail}. The next screen re-checks it.` };
    default:
      return { access: "undetermined", message: `${joining}. Could not determine access to ${repo} yet: ${v.detail}. The next screen re-checks it.` };
  }
}
```

Delete `NO_CREDENTIAL_PATTERN` (`lib/team/join.ts:53`) and the deferral comment above the old probe: its only use is the `joinDryRun` body this step replaces, and the probe owns that classification now. Task 11 greps for exactly this.

Widen `JoinResult` and add `intent`. `unreachableResult`/`deniedResult` keep serving `joinRedeem`; give them `intent: "written"` where they are already used post-redeem, or narrow their return type if that reads cleaner. `classifyGitFailure`/`gitAccessResult` lose their dry-run caller; delete whichever of them nothing else uses, and leave the rest alone.

- [ ] **Step 4: Run the tests**

Run: `bun test lib/team`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/team/join.ts lib/team/__tests__/join.test.ts
git commit -m "join dry-run: a real verdict at team continue, and the intent written either way"
```

---

### Task 7: The Swift contract and the extractor mirror

**Files:**
- Modify: `rt-tray/Sources-core/Contract/OtherResults.swift:25-49` (`TeamJoinResult`, `InviteResult`)
- Modify: `rt-tray/Sources-core/Launch/LaunchGuard.swift:17-25` (`JoinLink`)
- Modify: `rt-tray/Sources-core/Setup/TeamChoiceModel.swift:53` (`normalizedInviteCode`)
- Modify: `rt-tray/Sources/Setup/Screens/TeamScreen.swift:80` (field copy)
- Modify: `rt-tray/Tests/stub-rt/stub.ts:165` (invite fixture gains `link`)
- Test: `rt-tray/Tests/MattstackCoreChecks/LaunchChecks.swift`, `TeamChoiceChecks.swift`

**Interfaces:**
- Consumes: the fixture from Task 1, the JSON shapes from Tasks 2 and 6.
- Produces: `JoinLink.code(fromText:) -> String?`, `TeamJoinResult.intent: String?`, `InviteResult.link: String?`. Tasks 8, 9 and 10 use them.

- [ ] **Step 1: Write the failing checks**

In `LaunchChecks.swift`, drive the same fixture the TS suite uses. Resolve it from `#filePath` the way `SourceGuardChecks.swift:8` walks to repo files.

```swift
Check("JoinLink.code(fromText:) matches the shared fixture") { c in
    let repo = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
    let url = repo.appendingPathComponent("lib/team/fixtures/invite-code-inputs.json")
    struct Case: Decodable { let why: String; let input: String; let expect: String? }
    let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: url))
    c.expect(cases.count >= 10)
    for k in cases {
        c.expectEqual(JoinLink.code(fromText: k.input), k.expect, k.why)
    }
}
```

The four `deletingLastPathComponent()` calls are right for a file at `rt-tray/Tests/MattstackCoreChecks/LaunchChecks.swift`: filename, then `MattstackCoreChecks`, `Tests`, `rt-tray`. If the check cannot find the file, print the resolved URL rather than guessing at the depth.

In `TeamChoiceChecks.swift`:

```swift
Check("the join field takes a pasted link, and leaves anything else for the CLI to judge") { c in
    let m = await MainActor.run { TeamChoiceModel(rt: ScriptedRt(), pasteboard: FakePasteboard(nil)) }
    await MainActor.run { m.inviteCode = "mattstack://join/01234-56789-ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-89ABC-DEFGH-JKMNP-QRSTV-WXYZ0-12345-6789A-BC" }
    c.expectEqual(await MainActor.run { m.normalizedInviteCode }, "0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABC")
    await MainActor.run { m.inviteCode = "nope" }
    c.expectEqual(await MainActor.run { m.normalizedInviteCode }, "nope")
}
```

`FakePasteboard` and `init(rt:pasteboard:)` arrive in Task 8. Until then, construct the model exactly the way the file does today (`TeamChoiceModel(rt:)`), and let Task 8's sweep add the argument; do not invent a second initializer.

- [ ] **Step 2: Run them and watch them fail**

Run: `swift test --package-path rt-tray`
Expected: FAIL, `code(fromText:)` does not exist.

- [ ] **Step 3: Implement the Swift mirror**

In `LaunchGuard.swift`, beside the existing `code(from: URL)`:

```swift
    /// The URL shape is host-agnostic, matching lib/team/invite-crypto.ts: a
    /// link minted under RT_JOIN_BASE_URL carries the code in the same fragment.
    public static func code(fromText text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        var candidate = trimmed
        if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() {
            if scheme == "mattstack" {
                guard let code = code(from: url) else { return nil }
                candidate = code
            } else if let fragment = url.fragment, !fragment.isEmpty {
                candidate = fragment
            } else if url.host != nil {
                return nil
            }
        }
        let normalized = normalize(candidate)
        guard normalized.count == 77, normalized.allSatisfy({ alphabet.contains($0) }) else { return nil }
        return normalized
    }

    static let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    static func normalize(_ raw: String) -> String {
        String(raw.uppercased().compactMap { ch -> Character? in
            if ch == "-" || ch.isWhitespace || ch.isNewline { return nil }
            if ch == "O" { return "0" }
            if ch == "I" || ch == "L" { return "1" }
            return ch
        })
    }
```

Then `normalizedInviteCode` in `TeamChoiceModel.swift:53`, keeping today's behavior as the fallback so the CLI still owns malformed-code copy:

```swift
    public var normalizedInviteCode: String {
        JoinLink.code(fromText: inviteCode) ?? inviteCode.filter { !$0.isWhitespace && !$0.isNewline }
    }
```

- [ ] **Step 4: Add the JSON fields**

`TeamJoinResult` in `OtherResults.swift`: add `public var intent: String?` (`written | not-written`; nil means an older CLI) and update the trailing comment on `access` to `ok | deferred | no-account | denied | unreachable | undetermined`. `InviteResult`: add `public var link: String?`. Both initializers gain the parameter with a `nil` default so existing construction sites compile.

- [ ] **Step 5: Fix the stale field copy and the stub**

`TeamScreen.swift:80` now reads:

```swift
                Text("Paste the whole code (about \(TeamChoiceModel.inviteCodeLength) characters), or paste the mattstack://join link you were sent.")
```

`stub.ts:165`'s invite answer gains `link: "https://mattstack.dev/join#ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567"`. That stub code is 39 characters and is not extractor-valid, which is fine: it is hardcoded, never routed through the extractor, and the stub answers for it.

- [ ] **Step 6: Run the checks**

Run: `swift test --package-path rt-tray`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add rt-tray/Sources-core/Launch/LaunchGuard.swift rt-tray/Sources-core/Contract/OtherResults.swift rt-tray/Sources-core/Setup/TeamChoiceModel.swift rt-tray/Sources/Setup/Screens/TeamScreen.swift rt-tray/Tests/stub-rt/stub.ts rt-tray/Tests/MattstackCoreChecks/LaunchChecks.swift rt-tray/Tests/MattstackCoreChecks/TeamChoiceChecks.swift
git commit -m "app: accept a pasted join link, carry intent and link on the contract"
```

---

### Task 8: Paste invite, behind a click, behind a seam

macOS 15 and later raise a blocking permission alert on a programmatic pasteboard read, so nothing reads the clipboard until the joiner asks for it. `MattstackCore` cannot link AppKit, so the read arrives through a protocol.

**Files:**
- Create: `rt-tray/Sources-core/Setup/PasteboardReading.swift`
- Create: `rt-tray/Sources/Setup/SystemPasteboard.swift`
- Modify: `rt-tray/Sources-core/Setup/TeamChoiceModel.swift:49` (initializer), `rt-tray/Sources/Setup/Screens/TeamScreen.swift`, `rt-tray/Sources/Setup/SetupWindowController.swift:37`, `rt-tray/Sources/AccessibilityIDs.swift:6` (`AXID`, internal to the executable target)
- Modify: every `TeamChoiceModel(rt:)` site in `rt-tray/Tests/MattstackCoreChecks/TeamChoiceChecks.swift` (eleven as this plan was written, plus whatever Task 7 added)
- Test: `rt-tray/Tests/MattstackCoreChecks/TeamChoiceChecks.swift`

**Interfaces:**
- Produces: `PasteboardReading` with `func inviteText() -> String?`, `TeamChoiceModel.init(rt:pasteboard:)`, `TeamChoiceModel.pasteInvite()`.

- [ ] **Step 1: Write the failing checks**

```swift
final class FakePasteboard: PasteboardReading, @unchecked Sendable {
    private let value: String?
    private(set) var reads = 0
    init(_ value: String?) { self.value = value }
    func inviteText() -> String? { reads += 1; return value }
}

Check("Paste invite fills the field from a copied deep link") { c in
    let pb = FakePasteboard("mattstack://join/01234-56789-ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-89ABC-DEFGH-JKMNP-QRSTV-WXYZ0-12345-6789A-BC")
    let m = await MainActor.run { TeamChoiceModel(rt: ScriptedRt(), pasteboard: pb) }
    await MainActor.run { m.pasteInvite() }
    c.expect(await MainActor.run { !m.inviteCode.isEmpty })
    c.expectEqual(pb.reads, 1)
}

Check("nothing reads the pasteboard without a click") { c in
    let pb = FakePasteboard("mattstack://join/01234-56789-ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-89ABC-DEFGH-JKMNP-QRSTV-WXYZ0-12345-6789A-BC")
    let m = await MainActor.run { TeamChoiceModel(rt: ScriptedRt(), pasteboard: pb) }
    await MainActor.run { m.choice = .join }
    _ = await m.prepare()
    c.expectEqual(pb.reads, 0)
}

Check("a denied alert reads as nil and leaves whatever was typed alone") { c in
    let m = await MainActor.run { TeamChoiceModel(rt: ScriptedRt(), pasteboard: FakePasteboard(nil)) }
    await MainActor.run { m.inviteCode = "typed-so-far"; m.pasteInvite() }
    c.expectEqual(await MainActor.run { m.inviteCode }, "typed-so-far")
}

Check("a clipboard holding something else leaves the field alone") { c in
    let m = await MainActor.run { TeamChoiceModel(rt: ScriptedRt(), pasteboard: FakePasteboard("https://example.com/")) }
    await MainActor.run { m.pasteInvite() }
    c.expectEqual(await MainActor.run { m.inviteCode }, "")
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `swift test --package-path rt-tray`
Expected: FAIL, no `PasteboardReading`.

- [ ] **Step 3: Implement the seam and the action**

`rt-tray/Sources-core/Setup/PasteboardReading.swift` (no AppKit; `MattstackCore` does not link it, and a check that reads the real pasteboard would be nondeterministic):

```swift
public protocol PasteboardReading: Sendable {
    func inviteText() -> String?
}
```

`rt-tray/Sources/Setup/SystemPasteboard.swift`, in the target that does link AppKit:

```swift
import AppKit
import MattstackCore

/// macOS 15+ raises a permission alert on this read, so it happens only from
/// the Paste invite button. A denial is indistinguishable from an empty
/// clipboard here, and both mean "leave the field alone".
public struct SystemPasteboard: PasteboardReading {
    public init() {}
    public func inviteText() -> String? { NSPasteboard.general.string(forType: .string) }
}
```

In `TeamChoiceModel`:

```swift
    private let pasteboard: PasteboardReading

    public init(rt: RtRunning, pasteboard: PasteboardReading) {
        self.rt = rt
        self.pasteboard = pasteboard
    }

    public func pasteInvite() {
        guard let text = pasteboard.inviteText(), let code = JoinLink.code(fromText: text) else { return }
        inviteCode = code
    }
```

The argument is required on purpose: a defaulted no-op reader would turn a forgotten injection into a Paste button that silently does nothing.

- [ ] **Step 4: Sweep the construction sites**

Twelve as this plan was written: `SetupWindowController.swift:37` passes `SystemPasteboard()`; the eleven in `TeamChoiceChecks.swift` (lines 13, 35, 45, 54, 72, 85, 96, 102, 111, 126, 140 on today's file) pass `FakePasteboard(nil)` unless the check is about pasting. Task 7 adds a site of its own, so those line numbers have already shifted: drive the sweep off `grep -rn "TeamChoiceModel(" rt-tray` and convert every hit rather than the list.

- [ ] **Step 5: Add the button**

In `TeamScreen`, beside the code field:

```swift
                HStack {
                    Button("Paste invite") { model.pasteInvite() }
                        .accessibilityIdentifier(AXID.teamPasteInvite)
                    Text("macOS may ask permission to read your clipboard.")
                        .font(.caption).foregroundStyle(.secondary)
                }
```

Add `teamPasteInvite` to `AXID` (`rt-tray/Sources/AccessibilityIDs.swift:6`).

- [ ] **Step 6: Run the checks**

Run: `swift test --package-path rt-tray`
Expected: PASS, including the "nothing reads the pasteboard without a click" check.

- [ ] **Step 7: Commit**

```bash
git add rt-tray/Sources-core/Setup/PasteboardReading.swift rt-tray/Sources/Setup/SystemPasteboard.swift rt-tray/Sources-core/Setup/TeamChoiceModel.swift rt-tray/Sources/Setup/Screens/TeamScreen.swift rt-tray/Sources/AccessibilityIDs.swift rt-tray/Sources/Setup/SetupWindowController.swift rt-tray/Tests/MattstackCoreChecks/TeamChoiceChecks.swift
git commit -m "join screen: paste invite reads the clipboard only on a click, through a seam"
```

---

### Task 9: Team Continue warns, never blocks

**Files:**
- Modify: `rt-tray/Sources-core/Setup/TeamChoiceModel.swift:104-110`
- Modify: `rt-tray/Sources/Setup/Screens/TeamScreen.swift` (the warning row), `rt-tray/Sources/AccessibilityIDs.swift:6` (its id)
- Test: `rt-tray/Tests/MattstackCoreChecks/TeamChoiceChecks.swift`

**Interfaces:**
- Consumes: `TeamJoinResult.intent` and the widened `access` (Task 7), `FakePasteboard` and `init(rt:pasteboard:)` (Task 8).
- Produces: `TeamChoiceModel.joinWarning: String?`, rendered by `TeamScreen`.

- [ ] **Step 1: Write the failing checks**

```swift
Check("a denial warns and lets Continue through; the checklist holds the line") { c in
    let rt = ScriptedRt(); rt.answers["team join --dry-run --json"] = (0, #"{"contract":1,"team":{"slug":"acme","name":"Acme","owner":"matt"},"access":"denied","intent":"written","message":"Joining Acme. Your GitHub account cannot see acme/team yet: ask matt or your org admin to grant read access."}"#)
    let m = await MainActor.run { TeamChoiceModel(rt: rt, pasteboard: FakePasteboard(nil)) }
    let err = await m.prepare()
    c.expectEqual(err, nil)
    c.expect(await MainActor.run { m.joinWarning?.contains("ask matt") == true })
}

Check("an access value this build does not know still lets Continue through") { c in
    let rt = ScriptedRt(); rt.answers["team join --dry-run --json"] = (0, #"{"contract":1,"team":{"slug":"acme","name":"Acme","owner":"matt"},"access":"something-new","intent":"written","message":"Joining Acme."}"#)
    let m = await MainActor.run { TeamChoiceModel(rt: rt, pasteboard: FakePasteboard(nil)) }
    c.expectEqual(await m.prepare(), nil)
}

Check("no intent written still blocks") { c in
    let rt = ScriptedRt(); rt.answers["team join --dry-run --json"] = (0, #"{"contract":1,"access":"unreachable","intent":"not-written","message":"could not reach the invite relay"}"#)
    let m = await MainActor.run { TeamChoiceModel(rt: rt, pasteboard: FakePasteboard(nil)) }
    c.expect(await m.prepare() != nil)
}

Check("an older CLI with no intent field keeps the old rule") { c in
    let rt = ScriptedRt(); rt.answers["team join --dry-run --json"] = (0, #"{"contract":1,"team":{"slug":"acme","name":"Acme","owner":"matt"},"access":"denied","message":"no access"}"#)
    let m = await MainActor.run { TeamChoiceModel(rt: rt, pasteboard: FakePasteboard(nil)) }
    c.expect(await m.prepare() != nil)
}
```

Match `ScriptedRt`'s real keying in that file; the four behaviors are what matter.

- [ ] **Step 2: Run them and watch them fail**

Run: `swift test --package-path rt-tray`
Expected: FAIL, the first two block on a non-`ok` access.

- [ ] **Step 3: Implement the gate**

Replace the `guard j.access == "ok"` line:

```swift
                // An old CLI sends no intent; treat only "ok" as continuable
                // there, so it cannot wave a joiner past a denial it did check.
                let wrote = j.intent.map { $0 == "written" } ?? (j.access == "ok")
                guard wrote else {
                    return Self.joinFailureCopy(RtUserError(code: j.access == "denied" ? "no-access" : "unreachable", message: j.message ?? ""), owner: j.team?.owner, team: j.team?.name)
                }
                joinWarning = j.access == "ok" ? nil : j.message
                joinSummary = j.message ?? "Joining \(j.team?.name ?? "") (owner \(j.team?.owner ?? ""))"
```

Add `@Published public var joinWarning: String?` (or the file's existing observable idiom) and render it in `TeamScreen` under the code field, styled as a warning, with an `AXID` so a UI check can find it.

- [ ] **Step 4: Run the checks**

Run: `swift test --package-path rt-tray`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rt-tray/Sources-core/Setup/TeamChoiceModel.swift rt-tray/Sources/Setup/Screens/TeamScreen.swift rt-tray/Sources/AccessibilityIDs.swift rt-tray/Tests/MattstackCoreChecks/TeamChoiceChecks.swift
git commit -m "team continue: warn on a repo verdict, block only when no intent was written"
```

---

### Task 10: The owner sends a link

**Files:**
- Modify: `rt-tray/Sources/Settings/TeamPane.swift:34-44`
- Modify: `rt-tray/Sources/AccessibilityIDs.swift:6` (add `settingsTeamCopyLink`, `settingsTeamShareInvite`)
- Test: `rt-tray/Tests/MattstackCoreChecks/SettingsChecks.swift:26`

**Interfaces:**
- Consumes: `InviteResult.link` (Task 7).

- [ ] **Step 1: Write the failing check**

`SettingsChecks.swift` already scripts `team invite --handle bob`. Extend that answer with `"link":"https://mattstack.dev/join#ABCD"` and assert the model surfaces it:

```swift
Check("the minted invite carries the link the owner sends") { c in
    let rt = ScriptedRt()
    rt.answers["team invite --handle bob"] = (0, #"{"contract":1,"code":"ABCD","link":"https://mattstack.dev/join#ABCD","expiresAt":"2026-08-28T00:00:00Z","pasteBlock":"Install mattstack…","forgeAccess":"granted","manualSteps":[]}"#)
    let m = await MainActor.run { makeTeamSettings(rt).0 }
    await m.mintInvite(handle: "bob")
    c.expectEqual(await MainActor.run { m.invite?.link }, "https://mattstack.dev/join#ABCD")
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `swift test --package-path rt-tray`
Expected: FAIL. Task 7 already added `InviteResult.link`, so this fails on the assertion: the scripted answer in that check carries no `link` until you add it here.

- [ ] **Step 3: Add the buttons**

In `TeamPane.swift`, inside the `if let inv = model.invite` block, above the existing copy-paste-block row:

```swift
                        if let link = inv.link {
                            HStack {
                                Button("Copy invite link") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(link, forType: .string) }
                                    .accessibilityIdentifier(AXID.settingsTeamCopyLink)
                                Button("Share…") { share(link) }
                                    .accessibilityIdentifier(AXID.settingsTeamShareInvite)
                            }
                            Text(link).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        }
```

`share(_:)` is a small helper in the same file:

```swift
    /// The picker is how the link reaches Messages, Mail or AirDrop without rt
    /// ever handling a recipient.
    private func share(_ link: String) {
        guard let view = NSApp.keyWindow?.contentView else { return }
        NSSharingServicePicker(items: [link]).show(relativeTo: .zero, of: view, preferredEdge: .minY)
    }
```

Guard the whole block on `inv.link` being present rather than copying an empty string, as the spec requires.

`AXID` is internal to the `rt-tray` executable target, so no `MattstackCoreChecks` check can name these ids. They exist for the UI harness that drives the real app; the check above asserts the model, not the button.

- [ ] **Step 4: Run the checks**

Run: `swift test --package-path rt-tray`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rt-tray/Sources/Settings/TeamPane.swift rt-tray/Sources/AccessibilityIDs.swift rt-tray/Tests/MattstackCoreChecks/SettingsChecks.swift
git commit -m "team pane: copy invite link and a share sheet beside the paste block"
```

---

### Task 11: Whole-branch verification

**Files:** none created; fix whatever the gates surface.

- [ ] **Step 1: Run the full TypeScript gate**

Run: `bun run test:all`
Expected: PASS. `test:all` is unit plus e2e; plain `bun run test` skips e2e, and CI does not.

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Docs and picker conformance**

Run: `bun run docs:check && bun run picker:check`
Expected: PASS both. This plan adds no command leaf, so no `omitBehavior` declaration is needed; `picker:check` should be unchanged.

- [ ] **Step 4: Purity**

Run: `bash scripts/repo-purity.sh`
Expected: PASS. Never pipe it through `tail`.

- [ ] **Step 5: Swift**

Run: `swift test --package-path rt-tray`
Expected: PASS. Do not run `rt-tray/build.sh`.

- [ ] **Step 6: Confirm no second classifier came back**

Run: `grep -rn "could not read Username" --include="*.ts" lib commands | grep -v __tests__`
Expected: exactly one hit, `lib/team/repo-access.ts`. Test fixtures name the
string a dozen times, which is why the grep excludes them; two non-test hits
means Task 5 or Task 6 left its old pattern behind.

- [ ] **Step 7: Commit any fixes**

```bash
git add -A
git commit -m "verification: full gate green"
```

---

## Notes for the executor

- **Task 6's staged-token test leans on `readSecret` throwing `NoAgeKeyError`** under the isolated test HOME, which is what makes the lookup fall through to the stage. If it ever comes back `unreadable` instead, the cause is the store seam, not the fixture.
- **The clipboard alert behavior on macOS 15/26 is unconfirmed on a real machine.** The button copy assumes an alert may appear. If a real-machine check shows otherwise, the copy changes; the seam and the click-only rule do not.
- **`repoRow` deliberately still probes unauthenticated**, but its mapping does change: "could not read Username" on a tracked repo moves from `error` to `needs-you` with a Connect action, because that is the same honest statement there. Passing it a token is what stays out of scope.
- **Do not touch the forge grant path.** `rtMayManageMembership`, `createdByRt`, `grantRead`/`revokeRead` belong to MAT-409 and another worktree.
- **`mattstack.dev` prod serves a holding page**, so the minted link 404s in prod until the full site is redeployed. That is a deploy step outside this repo, not a defect in this work.
