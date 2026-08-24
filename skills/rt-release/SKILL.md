---
name: rt:release
description: Use when the user says release, cut a release, tag and release, ship a release, or push a new version of rt.
---

# rt Release

Update the rt.cool docs, write the GitHub release notes from the previous tag
to HEAD, commit them, and push a version tag. Pushing the tag is what publishes:
the `.github/workflows/release.yml` workflow (trigger `on: push: tags: v*`) builds
and notarizes **mattstack.app**, creates the GitHub release from the committed
`RELEASE_NOTES.md`, and attaches the `.dmg`, `.zip`, Sparkle deltas,
`appcast.xml`, and `SHA256SUMS`. You never create the GitHub release yourself;
CI owns the release object. Your job is docs, notes, the tag, verifying CI, and
deploying rt.cool.

A release also republishes the Claude Code plugin catalog: the workflow's first
step runs `scripts/release/marketplace.sh`, pushing `marketplace/` to
`m4ttstack/mattstack-marketplace`, which `plugins.install` adds on every machine
rt sets up. It needs the `MARKETPLACE_TOKEN` secret, but only on a release where
that catalog actually changed — an unchanged one is a no-op that pushes nothing.

> **rt no longer ships as standalone tarballs.** The `rt-darwin-arm64-*.tar.gz`
> / `rt-darwin-x64-*.tar.gz` artifacts this skill was written around are gone —
> `rt` is now the binary embedded at `Contents/MacOS/rt` inside the app bundle,
> and users update through Sparkle rather than by downloading a tarball.
>
> This skill still owns the docs/notes/tag half of a release. The build,
> signing, notarization, clean-room, and appcast half — plus the cross-repo
> coordination a release needs (deck, board, gitq, fast-browser, console) — is
> `~/.claude/skills/mattstack-release/SKILL.md`. Read that one before cutting a
> real release; read this one for the notes and the tag.

This supersedes the local `.claude/commands/release.md` command; that file can be
left as-is or reduced to a pointer here.

## Process

1. **Verify state.** On `main`, working tree clean (`git status --short` empty),
   and commits since the last tag (`git describe --tags --abbrev=0`, then
   `<last-tag>..HEAD` non-empty). Abort otherwise.

2. **Determine version bump.** From `git log --pretty=%s <last-tag>..HEAD`:
   any `feat(` or a new module/file is a minor bump; only `fix(` / `chore(` /
   `docs(` / `ci(` / `test(` is a patch bump; if ambiguous, ask.

3. **Push main.** If `main` is ahead of `origin/main`, push it. This is an
   outward action: unless the user pre-authorized the release, say what you are
   about to push and wait for confirmation.

4. **Update docs.** Run `bun scripts/update-docs.ts --no-agent`: it regenerates
   the command reference, runs the drift/coverage check, and scaffolds
   `RELEASE_NOTES.md` for `<last-tag>..HEAD`. Then, following
   `skills/rt-docs/SKILL.md`, update whichever guides, getting-started pages, or
   `_partials` the range's behavior changes require. Do the judgment yourself in
   this session; do not shell out to a nested headless Claude.

5. **Write the release notes.** Refine `RELEASE_NOTES.md` into the body that will
   be published verbatim: grouped by scope, a `### ` heading per section, one
   bullet per change, a `**Full Changelog**` compare link from the previous tag
   to the new tag at the bottom. Every line traces to a real commit in
   `git log <last-tag>..HEAD`; never invent or embellish. Calibrate tone against
   a prior release with `gh release view <last-tag>`.

6. **Show the user and get approval.** Print the proposed tag, the full
   `RELEASE_NOTES.md` body, and the docs diff (`git diff --staged --stat` for
   `website/`). Get explicit approval before committing, tagging, or deploying.
   Nothing below runs until this approval is given.

7. **Commit and push the notes, without tagging.** `RELEASE_NOTES.md` must be
   committed at the commit the tag will point to, because CI reads it as the
   release body. Scoped add only, never `git add -A`:
   ```
   git add website RELEASE_NOTES.md
   git commit -m "chore(release): docs and notes for <tag>"
   git push origin main
   ```
   Stop here. The tag comes after the rehearsal, so that the commit it will
   point at is the one that was actually exercised.

8. **Rehearse the pipeline.** Run `release.yml` via `workflow_dispatch` against
   the commit you just pushed. It builds, notarizes, and clean-rooms exactly as
   a tag does, but stamps `v0.0.0-ci<run>`, skips the release, validates the
   marketplace catalog without pushing it, and uploads `out/` as an artifact.
   Watch it green before continuing. This pipeline's defects have consistently
   been invisible until the step before them started working, so a rehearsal is
   the only thing that finds them cheaply — a tag that fails halfway has already
   re-signed the app and cost the user their TCC grants.

9. **Tag and push.**
   ```
   git tag -a <tag> -m "<tag>"
   git push origin <tag>
   ```
   Do NOT run `gh release create`. The tag push triggers `release.yml`, which
   builds and notarizes the app, publishes the marketplace catalog, creates the
   release from `RELEASE_NOTES.md`, attaches the artifacts, and installs from
   the zip in a clean room.

10. **Verify the publish.** Find the run (`gh run list --workflow=release.yml`)
   and watch it to completion (`gh run watch <run-id> --exit-status`), then confirm with
   `gh release view <tag>`: the body is your `RELEASE_NOTES.md` (not GitHub's
   auto-generated notes), and `mattstack-<ver>.dmg`, `mattstack-<ver>.zip`,
   `appcast.xml`, and `SHA256SUMS` are all attached. The workflow asserts those
   four itself before publishing, so a missing one fails the run rather than
   shipping a partial release. If CI failed or the body is wrong, report it
   rather than papering over it.

11. **Deploy rt.cool.** Run `bash scripts/deploy-docs.sh` (builds the site, deploys
   to Cloudflare Pages via wrangler). Needs wrangler auth (`wrangler login` or
   `CLOUDFLARE_API_TOKEN`) and the Pages project pointed at rt.cool's DNS, both
   one-time setup in the script header. If that setup is missing, tell the user
   the steps and stop rather than failing partway.

## Guardrails

- Never run `gh release create` or `gh release edit --notes` yourself. CI owns the
  release object. The curated notes reach it only by being committed as
  `RELEASE_NOTES.md` before the tag.
- No em dashes or en dashes in the notes; use commas, periods, or "...".
- Never invent a change that isn't in `git log <last-tag>..HEAD`.
- Never hand-write a command flag or arg table; those come only from
  `bun run docs:gen` (via `scripts/update-docs.ts`).
- Committing, tagging, and deploying happen only after the step 6 approval. The
  step 3 push may run earlier, but only once the user has confirmed it (or
  pre-authorized the release).
