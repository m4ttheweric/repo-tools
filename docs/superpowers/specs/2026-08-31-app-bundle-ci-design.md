# App-bundle CI: build mattstack apps from source into deps.lock

**Date:** 2026-08-31
**Repos touched:** `repo-tools` (rt), and each managed app repo (deck, board, console, chat, gitq)
**Status:** design ratified, ready for implementation plan

## Problem

The mattstack `.app` bundles every managed app as a prebuilt binary at
`Contents/Helpers/<name>`, pinned by `rt-tray/deps.lock` (url + sha256 +
version per row) and fetched/verified/signed by `build.sh`. Today only gitq
has a real row; `deck` and `board` are `status: "pending"` stubs with empty
url/sha, and `console`/`chat` have no row at all. Nothing produces those
binaries: each app repo has no release pipeline for a distributable darwin
binary, and there is no process that turns "an app changed" into an updated
deps.lock row.

RT-94 (deck dev-mode) makes this urgent: its resolver serves a managed app
from `Contents/Helpers/<name>` whenever `bundleExists`, and fails closed
(loud board issue, no serve) when neither a bundle nor a linked source
exists. On a prod install that is every managed app until these rows are
real. RT-94 explicitly declared the CI job and the app list a non-goal; this
design is that work.

## Goals

- One centralized, generic pipeline that builds any managed app's
  distributable binary **from that app's own main branch**, using build
  instructions the app repo itself declares. Adding an app never edits the
  workflow.
- Published artifacts are stable, plain-`curl`-fetchable, and pinned by
  sha256 so `build.sh` keeps working unchanged.
- The deps.lock update lands review-gated (a PR), never as a silent bot
  commit to the repo that ships the `.app`.
- Each app's release artifact also carries its agent `skills/` directory, so
  the `.app` can vendor per-app skills with zero per-app special cases
  (coordinated with the skills-shipping work).

## Non-goals

- Signing or notarizing the built binaries in CI. `build.sh` signs every
  helper at `.app` assembly time, as it does today for downloaded binaries.
- Changing the binary extract/verify/sign path in `build.sh` /
  `fetch-deps.sh`. The pipeline's output is deps.lock rows in the exact
  shape those scripts already consume (`archive: "tar.gz"` rows with an
  `extract` path). The one exception is the isolated skills-landing
  addition described under Artifact layout.
- Auto-releasing on every push. The pipeline is manual-dispatch by design;
  version bumps are deliberate.
- x64 / multi-arch. The bundle pipeline is arm64-only today
  (`deps/arm64`, `arch=arm64`); this follows it. The manifest schema carries
  no arch assumptions, so a second arch later is additive.
- Installing or linking the vendored skills on the user's machine. That is
  the skills-shipping work (deck-24's lane: `rt skills link --from <dir>`);
  this pipeline only guarantees the artifact carries `skills/` and the
  `.app` lands it at a stable path.

## Source-of-truth chain

Two declarations, each owned by the party that knows it:

1. **Which apps exist and where their source lives** — `rt-tray/deps.lock`
   rows gain a `repo` field (`"repo": "m4ttstack/deck"`). The set of rows
   with a `repo` field IS the buildable set. deps.lock is already the file
   the pipeline updates, so what-to-build and what-is-pinned cannot drift
   apart. Rows without `repo` (fzf, jq, node, cloudflared, sparkle...) are
   third-party pins the pipeline never touches.
2. **How an app builds and what it emits** — each app repo's
   `mattstack.deck.json` gains a top-level `bundle` node:

```jsonc
{
  "name": "deck",
  "port": 11000,
  "includeInBundle": true,
  "bundle": {
    "build": "bun install --frozen-lockfile && bun run bundle:compile",
    "artifact": "dist/deck"
  }
}
```

- `bundle.build`: a shell command run at the repo root on the runner. The
  repo owns its own recipe; the workflow runs it verbatim.
- `bundle.artifact`: repo-relative path to the built binary the command
  produces. The basename need not equal the app name; the pipeline stages it
  as `<name>` in the artifact layout.
- A dispatched app whose manifest is missing, unparsable, or lacks a
  complete `bundle` node **fails that app's build loudly**. The pipeline
  never guesses a build command.
- `bundle` is a sibling of RT-94's `dev` node in the same file and does a
  different job: `dev.build` is the developer's local dev-serve build;
  `bundle.build` is the standalone distributable compile
  (`bun build --compile` shaped). The keys are disjoint; both additive.

## Artifact layout and release

Per app, the pipeline publishes one GitHub Release **on that app's own
repo**:

- **Tag:** `v<version>`, where `<version>` is the app repo's root
  `package.json` version at the built commit. If the tag already exists, the
  build **fails loudly** ("bump the version") rather than overwriting a
  published artifact — same immutability rule every other deps.lock pin
  relies on.
- **Asset:** `<name>-darwin-arm64.tgz`, a tarball with this layout:

```
<name>                  # the built binary (staged from bundle.artifact)
skills/                 # verbatim copy of the repo's skills/ dir
  <skill-dir>/SKILL.md
  ...
```

- `skills/` is copied as-is from the repo root when present — no renaming,
  no flattening; each SKILL.md's frontmatter `name:` remains the namespace
  authority. A repo with no `skills/` simply omits it; not an error.
- The tarball (not a bare binary) is what deps.lock points at:
  `archive: "tar.gz"`, `extract: "<name>"` for the binary. The `.app` build
  additionally lands the tarball's `skills/` (when present) at
  `Contents/Helpers/skills/<app>/` — the stable path the skills-shipping
  work points `rt skills link --from` at. That landing is the one
  fetch/build change this design requires (isolated): `fetch-deps.sh`
  today keeps only the `extract` path from an archive, so it must
  additionally preserve a `skills/` dir when the archive carries one
  (e.g. to `deps/arm64/<name>-skills/`, covered by the same `$dest.sha256`
  idempotency stamp so a deleted skills dir re-materializes), and
  `build.sh` copies it to `Contents/Helpers/skills/<name>/`. The landed
  skill trees MUST join build.sh's signing pass (a plain signature, the
  way fast-browser's non-Mach-O files are signed): every regular file
  under `Contents/Helpers` is nested code, and one unsigned file makes
  the outer bundle seal refuse. Skill directory names must not contain a
  `.` or codesign treats them as nested bundles (the same trap the
  `.claude-plugin` prune exists for); the landing step prunes or rejects
  such names.
- The pipeline computes the tarball's sha256 after upload-staging and
  carries `{name, version, url, sha256}` forward to the PR step.

## The workflow

One file, `.github/workflows/bundle-apps.yml` in repo-tools.

- **Trigger:** `workflow_dispatch` with two inputs: `apps` (comma-separated
  names, or `all` = every deps.lock row bearing `repo`) and `dry_run`
  (boolean, default false).
- **Plan job (linux):** parse deps.lock, resolve the dispatched names to
  `{name, repo}` pairs, fail on an unknown name, emit a build matrix.
- **Build job (macos, arm64, matrix per app):**
  1. Clone `m4ttstack/<repo>` at `main` (depth 1); record the commit sha.
  2. Read `mattstack.deck.json`; validate `bundle.build` + `bundle.artifact`.
  3. Run `bundle.build`.
  4. Assert `bundle.artifact` exists, is executable, and exits 0 on
     `--version` — exactly the gate `check-bundle.sh` runs later (no
     `--help` fallback there, so none here), moved earlier.
  5. Stage `<name>` + optional `skills/`, tar, sha256.
  6. Unless `dry_run`: create the release on the app repo (tag from
     package.json version; fail if tag exists), upload the tarball.
- **PR job (linux, after all builds):** unless `dry_run`, check out
  repo-tools, rewrite each built app's deps.lock row (url, sha256, version,
  `status: "bundled"`, `archive: "tar.gz"`, `extract: "<name>"` — the last
  two matter for the deck/board stubs, which sit at `archive: "raw"` today;
  a raw-archive tarball row would ship the tarball bytes as the binary),
  and open a single PR titled for the batch, body listing each app's
  version + source commit. No direct pushes to main.
- Matrix failures are independent: one app failing does not block the
  others' releases; the PR includes only the apps that succeeded and the
  run summary names the failures.

## Auth

A fine-grained org PAT stored as a repo-tools Actions secret
(`MATTSTACK_RELEASE_TOKEN`), scoped to exactly: contents read+write on the
m4ttstack app repos (clone + create release), and contents write + PR
create on repo-tools. The default `GITHUB_TOKEN` cannot cross repos, so the
PAT is required; its narrow scope is the mitigation.

## deps.lock row shape (after)

```jsonc
{ "name": "deck", "version": "0.4.2", "license": "MIT",
  "repo": "m4ttstack/deck",
  "url": "https://github.com/m4ttstack/deck/releases/download/v0.4.2/deck-darwin-arm64.tgz",
  "sha256": "<computed>",
  "archive": "tar.gz", "extract": "deck", "bundlePath": "Contents/Helpers/deck",
  "exec": ["Contents/Helpers/deck"],
  "exposeByDefault": true, "entitlements": "jit", "status": "bundled", "kind": "helper" }
```

- `repo` is additive; `fetch-deps.sh` and `build.sh` ignore unknown fields
  (verify in the plan; if the TSV field extraction is positional, the field
  order must append, not insert).
- New rows for `console` and `chat` are added (as `pending` + `repo`) so the
  pipeline can build them.
- **gitq is two concerns, split cleanly by this design.** The gitq **CLI**
  is a bundled helper in its own right (its deps.lock row ships today,
  `exposeByDefault: true`) and is in the pipeline's buildable set either
  way: its row gains `repo: "m4ttstack/gitq"` and migrates to the tarball
  shape like the others, so the CLI keeps shipping regardless of any deck
  status. The gitq **served web app** (deck running `gitq board`) is a
  separate concern owned by RT-94's deck model: it stays a grandfathered
  deck row (`includeInBundle` false) until that work lands. The pipeline's
  buildable set keys on the deps.lock `repo` field, not `includeInBundle`,
  which is exactly what lets the CLI ship while the deck-app side waits.

## Error handling

- Unknown app name at dispatch: plan job fails, nothing builds.
- Manifest missing / no `bundle` node: that app's matrix leg fails with the
  exact remediation ("add bundle.build + bundle.artifact to
  mattstack.deck.json").
- Build command nonzero / artifact missing / smoke fails: leg fails; no
  release is created for that app.
- Tag collision: leg fails with "version <v> already released; bump
  package.json".
- Release created but PR step fails: the release is durable and idempotent
  to re-point at — re-dispatching the same app+version fails on the tag,
  so recovery is re-running just the PR job or hand-editing deps.lock;
  the run summary prints the url+sha for exactly this case.

## Testing surface

- **Row schema test (repo-tools, bun test):** every deps.lock row with
  `repo` has the full pinned shape or `status: "pending"`; `repo` matches
  `m4ttstack/<name-ish>`; no row is both `pending` and carrying a url.
- **Workflow lint:** `actionlint` in the existing checks workflow.
- **Dry-run as the e2e:** `dry_run: true` dispatch against one real app
  (deck) proves clone → manifest → build → smoke → sha without publishing.
- **Manifest validation unit (small script the workflow calls):** the
  parse/validate logic lives in a testable script
  (`scripts/bundle-ci/validate-manifest.ts`), not inline YAML, with tests
  for missing node / missing artifact / non-string build.
- **build.sh skills landing:** a fixture tarball with `skills/` lands at
  `Contents/Helpers/skills/<name>/`; one without `skills/` lands nothing.

## Coordination

- **RT-94 (mona):** shared file is each app's `mattstack.deck.json` only.
  RT-94 adds `dev` + `includeInBundle`; this adds `bundle`. Disjoint keys,
  both additive — merge in either order. One deliberate divergence from an
  RT-94 side remark: the buildable set keys on deps.lock `repo` rows, not
  `includeInBundle` (that field gates deck's dev/prod switch, not CI). The
  repo-row-to-bundle-node pairing is enforced where both sides are visible:
  the build job's dispatch-time manifest validation fails loudly when a
  `repo` row's manifest lacks a `bundle` node (a repo-tools unit test
  cannot read the other repos' manifests, and the pairing may legitimately
  lag — gitq's row can gain `repo` before its `bundle` node lands, with
  that leg failing loudly until it does). RT-94's resolver starts choosing
  the bundle automatically once these rows are real and installed
  (`bundleExists` flips true); that is the designed interlock, not a
  conflict.
- **fox (manifest owner):** `bundle` node shape needs fox's ack, same as
  `includeInBundle` (both provisional pending fox's CI-manifest ruling).
- **deck-24 (skills shipping):** artifact layout above is the agreed
  contract (2026-08-31): binary + verbatim `skills/` at tarball root,
  landed at `Contents/Helpers/skills/<app>/`.

## Open items carried into the plan

- ~~Hardening follow-up: isolate the release credential from the app's own
  build recipe.~~ **Done.** Publishing moved to a separate `release` job that
  only downloads the packaged tarball, so no secret-bearing step follows
  untrusted code in the same job. The build job keeps a token only for the
  clone and tag guard, both of which run *before* the recipe does. Alongside:
  top-level `permissions: contents: read`, `persist-credentials: false` on
  that checkout, and control-character rejection on the recipe and on the
  app-supplied version.
- Exact `bundle.build` recipe per app (each repo's own lane; deck/board/
  console/chat/gitq owners write theirs — the pipeline just runs them; a
  dispatch of an app whose `bundle` node hasn't landed fails that leg
  loudly, which the independent-matrix rule tolerates).
- Skills-presence-on-skip mechanics for `fetch-deps.sh` (how a skipped
  re-unpack knows the archive carried `skills/` — e.g. record presence
  beside the stamp); the plan picks one mechanism.
- Whether `check-bundle.sh` should assert `Contents/Helpers/skills/<app>/`
  contents for apps whose tarball carried skills (lean yes, cheap).
- PAT creation is a Matt-on-GitHub step (org settings); the plan marks it a
  manual precondition with exact scopes.
