---
name: rt-release
description: Use when the user says release, cut a release, tag and release, ship a release, or push a new version of rt.
---

# rt Release

Update the rt.cool docs, write the GitHub release notes from the previous tag
to HEAD, commit them, and push a version tag. Pushing the tag is what publishes:
the `.github/workflows/release.yml` workflow (trigger `on: push: tags: v*`) builds
the macOS binaries, creates the GitHub release from the committed `RELEASE_NOTES.md`,
attaches the tarballs, and updates the Homebrew tap. You never create the GitHub
release yourself; CI owns the release object. Your job is docs, notes, the tag,
verifying CI, and deploying rt.cool.

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

7. **Commit and tag.** `RELEASE_NOTES.md` must be committed at the tagged commit,
   because CI reads it as the release body. Scoped add only, never `git add -A`:
   ```
   git add website RELEASE_NOTES.md
   git commit -m "chore(release): docs and notes for <tag>"
   git push origin main
   git tag -a <tag> -m "<tag>"
   git push origin <tag>
   ```
   Do NOT run `gh release create`. The tag push triggers `release.yml`, which
   creates the release from `RELEASE_NOTES.md`, attaches the binaries, and updates
   Homebrew.

8. **Verify the publish.** Find the run (`gh run list --workflow=release.yml`)
   and watch it to completion (`gh run watch <run-id> --exit-status`), then confirm with
   `gh release view <tag>`: the body is your `RELEASE_NOTES.md` (not GitHub's
   auto-generated notes), and both `rt-darwin-arm64-*.tar.gz` and
   `rt-darwin-x64-*.tar.gz` are attached. If CI failed or the body is wrong,
   report it rather than papering over it.

9. **Deploy rt.cool.** Run `bash scripts/deploy-docs.sh` (builds the site, deploys
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
