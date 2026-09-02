rt now owns the pipeline run DB end to end. The write verbs that stage skills call moved out of a shell script and into `rt runs`, so every stage records its state through a bare `rt` word that Claude Code's worktree guard accepts. Around it: rooms wake on mention with claim and release for room questions, a `settings unset` verb, file:// marketplace sources, and a round of identity-resolution and CI-stability fixes.

### Runs

- `rt runs run-start|run-status|stage-start|stage-done|stage-fail|field|decision|snapshot`: the run DB's write side, with the same flags, JSON output, and exit codes as the pipeline-state.sh script it replaces; `stage-done` and `stage-fail` on a stage that was never started exit 3 instead of answering ok (#172)
- `run-start` keeps pack provenance (per-directory commit and dirty state, the mattstack sha, the pack sha) and the change-guarded session and pane identity fields; the git spawn it needs stays off the daemon's import graph (#172)
- every write emits `run-updated` to the daemon over its socket, best effort with a one-second timeout, so the console refreshes without the write ever depending on the daemon (#172)
- `rt runs <unknown>` is a usage error instead of falling through to the list; an empty value for a required flag is a usage error; `--mattstack-dirty` takes only 0 or 1 (#172)
- `rt runs abandon` writes through the same code as the pipeline and returns the contract's error on a corrupt run DB instead of throwing (#172)

### Chat

- rooms default to wake-on mention: a post wakes the handles it @mentions, `@here` wakes everyone, and the human's post always wakes the room; every existing member is reset from all to mention (v11); an un-addressed post tells its poster "on the record for N members, woke nobody" and what to send instead (#171)
- `rt chat claim <messageId>` and `rt chat release <messageId>`: test-and-set on who answers a room question, a receipt to the author when a claim is won, a lost claim exits 0 and wakes nobody (#166)

### Settings

- `rt settings unset <key>`: remove a written key without hand-editing the store (#169)

### Skills

- pack discovery reads packs served as file:// url sources, since Claude Code 2.1.257 refuses plugin paths that resolve through a symlink outside the marketplace; a malformed file:// entry is skipped instead of aborting discovery (#173)

### Setup and teams

- `rt team create` defers git to Install when Command Line Tools are absent, so a clean Mac no longer hits Apple's git stub and its install dialog at the Team step
- vm: the create scenario fills the team repo URL the pasted-remote card requires; `ax_find` returns the element class, not an uncoercible reference

### Identity resolution

- the last three identity-resolution drift sites are closed: ready-held approveArg resolves the canonical key by lookup instead of derivation, legacy names the index no longer keys are still found, and the `mr:*` verbs gain the identity guard so an unknown repo answers repo-unknown instead of a raw index error (#167)

### Health and CI

- health no longer judges rss growth before the process has a full window of history, ending the false "grew >50% in the last hour" banner after every restart (#168)
- the parity test retries the gone-fixture delete that silently no-ops on macOS CI, and the parity meter records delete-visibility latency before re-deleting (#170)
- check-bundle fails on Helpers entries that deps.lock does not declare

### Documentation

- generated reference tables escape `|` inside cells; `docs:check` looks for `_partials` in the real reference directory; retired rt status links are dropped from the hand-written pages

**Full Changelog**: https://github.com/m4ttstack/rt/compare/v2.8.0...v2.9.0
