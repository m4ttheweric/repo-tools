---
name: rt-release
description: Use when the user says release, cut a release, tag and release, ship a release, or push a new version of rt ... update the docs, generate GitHub release notes from the previous tag to HEAD, tag and publish the release, then deploy rt.cool.
---

# rt Release

Push any unpushed commits on main, update the rt.cool docs, generate GitHub
release notes from the previous tag to HEAD, tag and publish the release,
then deploy rt.cool. This skill supersedes the local `.claude/commands/release.md`
command, which covered verify, version bump, push, draft notes, approval, and
tag/publish but had no docs-update or deploy step; that file can be left as-is
or reduced to a pointer at this skill.

## Process

1. **Verify state.** Confirm we're on `main`, the working tree is clean
   (`git status --short` empty), and there are commits since the last tag
   (`git describe --tags --abbrev=0`, then check `<last-tag>..HEAD` is
   non-empty). Abort otherwise.

2. **Determine version bump.** Inspect commit subjects since the last tag
   (`git log --pretty=%s <last-tag>..HEAD`):
   - Any `feat(` prefix or new module/file creation -> minor bump
   - Only `fix(`, `chore(`, `docs(`, `ci(`, `test(` -> patch bump
   - If ambiguous, ask.

3. **Push.** If `main` is ahead of `origin/main`, push it. This is an
   outward, irreversible-in-spirit action, so if the user has not already
   pre-authorized the whole release, say what you're about to push and wait
   for confirmation before running it.

4. **Update docs.** Run `bun scripts/update-docs.ts --no-agent` for the
   deterministic part: it regenerates the command reference, runs the
   drift/coverage check, and scaffolds `RELEASE_NOTES.md` for
   `<last-tag>..HEAD`. Then, following the procedure in
   `skills/rt-docs/SKILL.md`, update whichever concept guides, getting-started
   pages, or `_partials` the range's behavior changes actually require. You
   are the interactive agent doing that judgment yourself in this session;
   do not shell out to a nested headless Claude the way
   `scripts/update-docs.ts` does by default (that's what `--no-agent`
   avoids).

5. **Compose the GitHub release notes.** Refine the `RELEASE_NOTES.md`
   scaffold into the notes body that will actually be published: grouped by
   scope, a `### ` heading per section, one bullet per change, and a
   `**Full Changelog**` compare link from the previous tag to HEAD at the
   bottom. Every line must trace back to a real commit in
   `git log <last-tag>..HEAD`; never invent or embellish a change that
   isn't there. Calibrate tone and section naming against a real prior
   release with `gh release view <last-tag>`.

6. **Show the user and get approval.** Print the proposed tag, the full
   release body, and the docs diff (`git diff --staged --stat` for
   `website/` plus the `RELEASE_NOTES.md` contents). Get explicit approval
   before creating, tagging, publishing, or deploying anything. Nothing in
   step 7 or step 8 runs until this approval is given.

7. **On approval, commit, tag, and publish.** Commit the staged docs and
   notes with a scoped add (`git add website RELEASE_NOTES.md`, never
   `git add -A`), create the annotated tag for the version decided in step
   2, and run `gh release create <tag> --notes-file RELEASE_NOTES.md`.

8. **Deploy rt.cool.** Run `bash scripts/deploy-docs.sh` (builds the
   Docusaurus site and deploys it to Cloudflare Pages via wrangler). This
   needs wrangler authenticated (`wrangler login` or `CLOUDFLARE_API_TOKEN`
   set) and the Cloudflare Pages project already pointed at rt.cool's DNS;
   both are one-time maintainer setup documented in the script's header
   comment. If that setup isn't done yet, tell the user the exact steps
   from the header and stop there rather than letting the deploy fail
   loudly partway through.

9. **Guardrails.**
   - No em dashes or en dashes anywhere in the release notes; use commas,
     periods, or "..." instead.
   - Never invent a change that isn't in `git log <last-tag>..HEAD`.
   - Never hand-write a command flag or arg table; those are owned by doc
     regeneration (`bun run docs:gen`, wrapped by `scripts/update-docs.ts`),
     never by this skill.
   - The tag, `gh release create`, and deploy happen only after the step 6
     approval, never before it. The step 3 push is the one exception: it may
     run earlier, but only once the user has confirmed that push specifically
     (or pre-authorized the whole release).
