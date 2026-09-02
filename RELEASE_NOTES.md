Two big moves in one release. rt's pickers leave fzf for an in-house picker with grouped rows, multi-select, action menus, and breadcrumbs, everywhere a picker appears. And rt now owns the pipeline run DB end to end: the write verbs that stage skills call moved out of a shell script and into `rt runs`, so every stage records its state through a bare `rt` word that Claude Code's worktree guard accepts. Around them: rooms wake on mention with claim and release for room questions, a `settings unset` verb, file:// marketplace sources, a hardened setup checklist for a clean Mac, and release rehearsals that behave like a real tag.

### Picker

- every rt picker now runs on an in-house picker (`rt-ui pick`) instead of fzf: fzf's own fuzzy matcher pinned headless, grouped rows with a stable frame height, multi-select with a selected panel, a ctrl-k action menu, modifier-held key bars, mouse support, and in-card breadcrumbs (#174)
- `rt cd`, `rt nav`, `rt run`, `rt commit`, `rt sdm`, the worktree and skills pickers, and the arg collector are migrated; nav is rebuilt on the events model (descend in place, sort modal, watcher, ctrl-k menu); every cancel path prints one shared "aborted" line (#174)
- fzf is no longer a runtime dependency: `fzf.ts`, `fzf-select.ts`, and `nav-watch.ts` are deleted, `tool.fzf` coverage is dropped, and the docs point at the picker design (#174)
- go: termios is restored and a pick is cancelled on signal or EOF; stdout redirection leaks in the cd and nav pickers are fixed; tabs are expanded so the renderer emits cursor moves rather than TAB (#174)

### Runs

- `rt runs run-start|run-status|stage-start|stage-done|stage-fail|field|decision|snapshot`: the run DB's write side, with the same flags, JSON output, and exit codes as the pipeline-state.sh script it replaces; `stage-done` and `stage-fail` on a stage that was never started exit 3 instead of answering ok (#172)
- `run-start` keeps pack provenance (per-directory commit and dirty state, the mattstack sha, the pack sha) and the change-guarded session and pane identity fields; the git spawn it needs stays off the daemon's import graph (#172)
- every write emits `run-updated` to the daemon over its socket, best effort with a one-second timeout, so the console refreshes without the write ever depending on the daemon (#172)
- `rt runs <unknown>` is a usage error instead of falling through to the list; an empty value for a required flag is a usage error; `--mattstack-dirty` takes only 0 or 1 (#172)
- `rt runs abandon` writes through the same code as the pipeline and returns the contract's error on a corrupt run DB instead of throwing (#172)
- `rt runs find --session <id> [--running]`: the run DB whose `claude-session` field matches, newest first, read-side with no daemon, so a hook can find its own run (#175)

### Chat

- rooms default to wake-on mention: a post wakes the handles it @mentions, `@here` wakes everyone, and the human's post always wakes the room; every existing member is reset from all to mention (v11); an un-addressed post tells its poster "on the record for N members, woke nobody" and what to send instead (#171)
- `rt chat claim <messageId>` and `rt chat release <messageId>`: test-and-set on who answers a room question, a receipt to the author when a claim is won, a lost claim exits 0 and wakes nobody (#166)

### Settings

- `rt settings unset <key>`: remove a written key without hand-editing the store (#169)

### Skills

- pack discovery reads packs served as file:// url sources, since Claude Code 2.1.257 refuses plugin paths that resolve through a symlink outside the marketplace; a malformed file:// entry is skipped instead of aborting discovery (#173)
- `{{run-start.flags:<verb>}}` renders one run-start line for a standalone verb, so review, ship, and watch-ci verbs can start a single-stage run of their own (#175)
- `rt skills compile` keeps a pack's own engine source at `attachments/<verb>/SKILL.md` when that verb compiles as public into `skills/<verb>/`; only a directory carrying the compiler header is swept as a flipped prior compile (#177)

### Setup and teams

- setup checklist: three required rows a clean Mac could never clear now can; herdr's Claude integration and Claude's sign-in never gate Install; the checklist's relaunch returns to the checklist, not Welcome
- setup probes resolve a bare command in `~/.local/bin` when PATH has none, and `tool.rt` accepts the `~/.local/bin` link before Install has put it on PATH
- the Full Disk Access probe never lets a refusal decide, and drops the app-container path macOS 26 refuses above FDA
- `rt setup connect` stages credentials until the personal secrets store is writable
- `rt team create` defers git to Install when Command Line Tools are absent, so a clean Mac no longer hits Apple's git stub and its install dialog at the Team step
- vm harness: the create scenario fills the team repo URL the pasted-remote card requires, drives the rt link and the herdr and claude vendor installs before Install, fills macOS 26's in-window privacy auth sheet, reads System Settings toggles back, waits on wall-clock rows, and logs every checklist row and the on-screen windows when an accessibility lookup fails

### Identity resolution

- the last three identity-resolution drift sites are closed: ready-held approveArg resolves the canonical key by lookup instead of derivation, legacy names the index no longer keys are still found, and the `mr:*` verbs gain the identity guard so an unknown repo answers repo-unknown instead of a raw index error (#167)

### Release pipeline and purity

- release rehearsals (workflow_dispatch) stamp a patch-bump above the latest published release, so generate_appcast writes their enclosure against a populated feed; the release-workflow test pins that stamp
- repo-purity extends its banned-term list, and employer and customer terms across the tree are scrubbed to neutral placeholders

### Health and CI

- health no longer judges rss growth before the process has a full window of history, ending the false "grew >50% in the last hour" banner after every restart (#168)
- the parity test retries the gone-fixture delete that silently no-ops on macOS CI, and the parity meter records delete-visibility latency before re-deleting (#170)
- check-bundle fails on Helpers entries that deps.lock does not declare

### Documentation

- generated reference tables escape `|` inside cells; `docs:check` looks for `_partials` in the real reference directory; retired rt status links and stale fzf mentions are dropped from the hand-written pages; the git commit reference is regenerated after the picker cutover

**Full Changelog**: https://github.com/m4ttstack/rt/compare/v2.8.0...v2.9.0
