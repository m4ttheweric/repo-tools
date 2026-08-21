# The home-repo program — suite settings + secrets + snapshot/restore (spec)

RT-50 step 2, expanded twice by Matt (2026-08-20): first to cover every mattstack
app (rt, deck, board, gitq), then to fold in **RT-32** (secrets sops/age-encrypted
IN the repos) and **RT-30** (~/.mattstack becomes the git-backed home repo with an
auto-snapshot daemon). Governing doctrine: MAT-374. RT-31 (restore + materialize
contract) is recommended IN — it is the acceptance test of the whole architecture
and the age-key bootstrap lives there. Deck's state.db adoption and the
mattstack-TLD rehome remain MAT-384; board/gitq state.db adoption is a follow-on
lane.

## Workstream H — home repo (RT-30, per MAT-374 rulings 1-3, 5)

- `rt home init`: provision a private GitHub repo (`gh`), make `~/.mattstack` the
  clone. Adoption: today `~/.mattstack` is NOT a repo; `user/` is the
  mattstack-prefs clone and `teams/claimview` a team clone. Ruling needed→taken:
  mattstack-prefs' history and content fold INTO the home repo as `user/` (its
  standalone remote retires); team clones stay independent nested clones,
  gitignored by the home repo.
- The gitignore IS the boundary: tracked = declarative (`user/`, `skills.jsonc`,
  snapshot-owners.jsonc, per-tool declarative zones as they adopt); encrypted-
  tracked = secrets; ignored = runtime (`rt/`, `deck/` runtime files,
  `shepherdr/` (jobs/runs/worktrees), `repos/`, `ci-attendants/`, `work/`,
  `teams/`, `user/local/` (machine-local; holds attic tarballs today),
  `settings.local.jsonc` — machine-local never travels, per MAT-374 stratum 5).
  The fold-in preserves mattstack-prefs' own `.gitignore` semantics; `user/local/`
  is additionally hoisted into the home repo's ignore so the boundary does not
  depend on the inner file surviving. Stray root cruft (`skills.jsonc.pre-pack`,
  `skills.jsonc.retired-backup`) is deleted at H1, not adopted.
- Fold-in mechanism hint for the planner: rewrite mattstack-prefs history under
  `user/` (`git filter-repo --to-subdirectory-filter user`), merge into the new
  home repo with `--allow-unrelated-histories`, remove the nested `user/.git`;
  team clones under `teams/` stay independent nested clones, ignored.
- Snapshot daemon (in the rt daemon): watches tracked paths, debounced
  auto-commits with per-path messages, background push. `snapshot-owners.jsonc`
  committed; claimed zones are never auto-committed; janitor commits a marked
  snapshot when a claimed zone stays dirty past threshold.
- Strict TDD; git/exec seams thin.

## Workstream S — secrets layer (RT-32, per MAT-374 ruling 4)

- sops/age: secret paths under the home repo encrypt transparently on commit;
  decrypt only on machines holding the age key. Age key: generated at init,
  macOS keychain, never in the repo; documented key-migration channel.
- Rotation ceremony: one command re-mints/re-encrypts a named secret + commits.
  Doctrine: rotate, never rewrite history.
- **Age-key migration channel (ruling):** `rt home key export` prints the age
  secret key once for the user's password manager; `rt restore` prompts to paste
  it and installs it in the keychain. The password manager is the channel —
  pre-trusted, works on a bare machine, teammate-viable. Never written to the
  repo, never to a synced file.
- Secret inventory migrating in (from the four surveys):
  `~/.mattstack/rt/secrets.json` (linear/gitlab/sdm/switchboard tokens), deck's
  `cfApiToken`/`cfZoneId` (today plaintext 0644), its session `secret`, and its
  per-app `passwordHash`es (hashes are secrets here — the user store is
  git-synced, and the local-apps incident is exactly hashes-in-git), board's
  `.env` SLACK_TOKEN plus SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET (the
  reworked setup/integration flow reads them from S). Deleted, not carried:
  board's orphaned CF_API_TOKEN/CF_ACCOUNT_ID. Non-secret slack identifiers
  (SLACK_APP_ID, SLACK_CLIENT_ID) live in `mattstack.integrations.slack` (team).
- Consumers move to a single read API in the shared settings module (decrypts via
  sops/age locally); the rt daemon's grant-gated `secrets:forge-token` verb stays
  the out-of-process path (gitq precedent). The rt-context VS Code extension's
  direct `secrets.json` read moves to a daemon call — in scope, it blocks
  deleting the plaintext file.
- Pods/lanes never get the age key (deploy-key readers see ciphertext only).
- Where the classifier blocks agent secret-handling, the lane hands Matt the
  mint/rotate commands instead of running them.

## Workstream R — restore + materialize (RT-31, recommended in)

- `rt restore <org>/<repo>`: clone to `~/.mattstack`, age-key bootstrap from
  keychain/channel, then materialize: every tool's materialize-from-config verb
  runs (rt itself, then deck/board/gitq as they adopt). claude.marketplaces/
  claude.plugins replay is the installer handoff's need #4.
- The materialize contract is the regeneration rule: anything unrecoverable from
  the declarative layer is a bug in what we declared.

Evidence: four survey reports (2026-08-20) over repo-tools@137a840, local-apps,
mr-board, gitq. Key facts cited inline.

## The suite standard

- **Stores** (existing, RT-47): user `~/.mattstack/user/settings.jsonc` (a git repo
  — mattstack-prefs), team `~/.mattstack/teams/<team>/mattstack/settings.jsonc`,
  machine `~/.mattstack/settings.local.jsonc`. Flat key namespace with app
  prefixes: `rt.*`, `deck.*`, `board.*`, `gitq.*`. Repo-scoped sections keyed by
  normalized remote identity, exactly as rt does today.
- **One resolver, many processes.** The resolver implementation moves to the
  shared package (`@mattstack/rt-client` grows a `settings` module housing what is
  today `lib/settings/{resolve,stores,identity,registry,write}.ts`, splitting
  machinery from per-app def tables in the move); rt imports it from there,
  deck/board/gitq consume it in-process via their rt-client dependency (board:
  file:, gitq: npm — today wrongly in devDependencies while imported at runtime,
  fixed in the gitq lane; deck: adds it via npm). No daemon
  round-trip for reads — apps that boot before the rt daemon (deck) must still
  resolve. The daemon's `settings:get/list` verbs stay for out-of-process callers.
- **One suite registry, in the shared package.** The installer lane (handoff
  2026-08-20) requires `rt settings set` to accept deck/board/gitq/mattstack/
  claude keys — so the key table is a single suite registry living beside the
  resolver in the shared package. Each app imports the machinery plus its own
  prefix's defs; `rt settings list/get/explain/set` operate over the whole suite
  table. App key changes ride an rt-client version bump (acceptable: single
  maintainer, file:/npm consumers already re-install on change).
- **Scope hygiene (hard rule):** the user store is git-synced — never a secret,
  never an absolute path (pathGuardFields already enforce the path half for
  user/team). Secrets stay out of ALL stores until RT-32; machine-local paths and
  identities go to machine scope.
- **Write path:** `setSetting` (comment-preserving jsonc edit, refusal ladder,
  team never auto-created). Migration order per key is atomic: port the reader to
  the resolver + flip `migrated: true` + write the store value in one change.

## rt key dispositions

| Key / file | Disposition | Scope | Notes |
|---|---|---|---|
| `rt.cron` (cron.jsonc) | migrate | machine | absolute paths; boot-only reader — `rt settings set` prints daemon-restart hint |
| `rt.llm` (llm.json) | **DELETE** (Matt, 2026-08-20) | — | dead chain post-branch-removal: `llmPrompt` has zero production callers; delete lib/llm.ts, the `rt settings llm` verb, llm.json, the registry row, tests |
| `rt.notifications` (notifications.json) | migrate | user | pure prefs; notifier re-reads per call → propagates live |
| `rt.repoTracking` (repo-tracking.json) | migrate | machine | ruled; keys are repo names not identities; per-tick reads → live |
| `rt.runaway` (runaway-config.json) | migrate | machine | thresholds; boot-only-ish, keep restart hint |
| `rt.workspacePrefs` (workspace-prefs.json) | migrate | machine | absolute dirs; rt nav reader |
| `rt.sync` (repos/assured-dev/sync.json) | migrate | team.repo | autoResolve rules are repo conventions |
| `rt.variations` (variations.json) | migrate | team.repo | pgr-qa variation is team knowledge |
| `rt.presets` (presets/*.json) | migrate | user.repo | personal run presets; SHAPE CHANGE: dir-of-files → `{ "<name>": {entries} }` |
| `rt.dopplerTemplate` (doppler-template.yaml) | migrate | team.repo | YAML→JSONC conversion; reconciler reads via resolver afterward |
| `rt.branchNaming` (branch-naming.json) | migrate value, KEEP file | team.repo | rt has zero readers; file stays for the VS Code ext until it follows (ext reads by repo NAME, not identity — its port is a separate change) |
| `rt.hooks` (repos/*/hooks.json) | **DEFERRED** | — | generated bash shims grep hooks.json directly; migrating requires shim regeneration — its own small lane; registry row stays migrated:false |
| panel-columns.json | not settings | — | Swift-tray-only UI state; leave; revisit in the tray UI session |
| logdy-pino-columns.json | not settings | — | generated artifact for logdy; regenerated by commands/daemon.ts |
| endpoints.json | not settings | — | runtime port claims (daemon-owned) |
| agent-tasks/ | delete cruft | — | write-only July artifacts + a stray `repos/origin/agent-tasks` path-bug dir |
| repos/*/config.json + lib/repo-config.ts | **DELETE** | — | zero callers post step 1; the legacy rung is its only reader |
| secrets.json | workstream S: contents move to the encrypted secret paths; plaintext file deleted once the rt-context extension reads via the daemon | encrypted |
| `rt settings linear team` surface | **DELETE (recommend)** | — | write-only, zero readers (step-1 finding); pending Matt's ruling |

**Legacy rung deletion:** the rung serves only `rt.roles`/`rt.intercepts`/
`rt.worktrees` out of per-repo config.json, whose values already live in the team
store (RT-47). Delete resolve.ts:156-196 + collectSlots wiring + `legacy` scope +
caller opts (endpoint/config.ts, worktree/config.ts, settings-keys.ts) + the
config.json mtime probe in endpoint/shim.ts + the legacy test suite (mapped in the
survey). After this, `~/.mattstack/rt` holds runtime only.

## deck (MAT-384 settings half)

| Item | Disposition | Scope |
|---|---|---|
| settings.json `apps.*.published`, `publicFollowsOverride` | `deck.apps` store key | user |
| settings.json `apps.*.passwordHash` | workstream S encrypted secret path (hashes never enter a plaintext store) | encrypted |
| settings.json `secret`, `apps.*.override`, `passwordVersion` | runtime → stays local (state.db when MAT-384 lands) | — |
| access.json | `deck.access` store key | user |
| platform.json `publicDomain`, `legacyPrefixes` | `deck.platform` store key | machine |
| platform.json `tlds` | derived cache from portless — NOT settings; stays runtime | — |
| platform.json `secrets.cfApiToken/cfZoneId` | workstream S: sops/age-encrypted secret path in the home repo; deck reads via the shared secrets API | encrypted |
| registry.json, api.json | untouched here (MAT-384 state.db) | — |

**Security fixes riding along (both found in survey):**
1. `local-apps/data/settings.json` is git-tracked with real argon2 hashes + a live
   session secret; checkout-mode runs read/write it. Fix: untrack + gitignore,
   point checkout runs at the state dir, rotate the session secret and the hashes'
   passwords (Matt), note history rewrite as Matt's call.
2. platform.json (and the new interim secrets file) get 0600.

Deck adds the rt-client dependency and replaces its four eager hand-rolled caches
for the migrated keys with resolver reads (its boot-env import-ordering contract
must be preserved; hot-reload semantics unchanged — deck restart applies edits).

## board

| config.json key(s) | Disposition | Scope |
|---|---|---|
| gitlabHost, projects, members (full roster + hidden defaults), title, botUsernames, ticketPrefixes, slack.* | `board.*` keys | team |
| staleAfterDays, *Workspace names, defaultMember, triage user-intent flags | `board.*` keys | user |
| claudeCommand, reviewCwd/respondCwd/doctorCwd, rtRepos, triage.maxConcurrent | `board.*` keys | machine |
| port, host | DELETE (deck's PORT env is authoritative; survey: config port is dead) |
| reviewSkill, respondSkill | DELETE (dead — skills.jsonc manifests shadow them) |
| doctorSkill + triage.doctorSkill | keep BOTH as distinct keys with today's distinct semantics (BOARD-14: triage variant is never manifest-resolved) |
| switchboard.url | machine key; the `POST /peer/join` writer moves to a machine-scope setSetting |
| members[].hidden toggle | user-scope write (board's settings write goes through the shared writer) |
| config.team.json + materialize + setup.ts seeding | RETIRED — the team store IS the team layer; setup reads stores |
| .env orphaned CF_API_TOKEN/CF_ACCOUNT_ID | delete lines (orphaned secret) |
| state/* files | untouched (state.db lane later) |

## gitq

| Item | Disposition | Scope |
|---|---|---|
| settings.json workSlotLocation, maxWorkSlots | `gitq.*` keys | machine |
| settings.json forges (host-keyed map, tokenEnv names only) | `gitq.forges` key | user |
| checkout config.json repos, port, herdrWorkspace | `gitq.board` key | machine |
| stacks/, operation-log.json, state/jobs/, leases, pause files | untouched (state.db lane later) |
| repos.json + generated/ accessors, src/core/linear.ts | DELETE (dead, zero callers) |
| README secrets-fallback claim (:147) | fix (stale — direct secrets.json reads removed in MAT-33) |

gitq's `GITQ_CONFIG_DIR` import-time snapshot and the four frozen legacy constants
must be handled so tests keep isolating (bunfig preload contract preserved).

## Installer-lane keys (handoff-2026-08-20-installer-needs-from-settings-lane.md)

The installer consumes whatever this lane rules; these are the rulings:

| Need | Key(s) | Scope | Shape ruling |
|---|---|---|---|
| Team integrations | `mattstack.integrations` | team | as proposed: `{forge:{host,provider}, slack?:{appId,clientId,channel,callbackPort}, linear?:{teamKey}, switchboard?:{url}}`; client secrets → RT-32, never here |
| Team tracking intent | `mattstack.tracking` (team) layered over `rt.repoTracking` (machine) | team + machine | team key is IDENTITY-keyed (`host/group/repo`) declared intent; machine key stays NAME-keyed grants as today; the daemon merges (machine wins per-repo) resolving identities→names via the repo index |
| Pack requirements | NOT a settings key | — | pack-side `requirements.jsonc` next to the manifest — requirements travel and version with the pack; `rt setup plan` reads it |
| Claude plugin replay | `claude.marketplaces`, `claude.plugins` | user + team | flat arrays; restore (RT-31) replays them |
| Suite-app keys | the deck/board/gitq tables above | as ruled above | registered in the suite registry, so `rt settings set` accepts them |
| App bundle path | `mattstack.appPath` | machine | written by the app at launch; rt reads it instead of hardcoding `~/Applications` |
| Triage cron | `rt.cron` machine key | machine | installer appends a trigger via `rt settings set` once migrated |

Follow-ups this lane creates but does not do: the rt-context extension's move
off name-keyed `branch-naming.json` (blocker for retiring those files). NOT a
follow-up: the extension's direct `secrets.json` read — that port is IN
workstream S (it blocks deleting the plaintext file). A reply file with final
key names goes next to the installer handoff now that Matt has ratified.

## Sequencing (deadline-shaped: every lane separately mergeable)

1. **H1 — home repo init + gitignore boundary** (RT-30 provisioning half).
   `~/.mattstack` becomes the clone with the layer boundary correct BEFORE any
   new content lands in git. mattstack-prefs folds in as `user/`.
2. **S — secrets layer** (RT-32). Must precede any migration that touches a
   token (deck's CF token, board's env writers, rt secrets consumers).
3. **E — resolver + suite registry extraction** into the shared package
   (pure refactor; consumers bun-install).
4. **RT keys wave** (table above) + legacy rung deletion + repo-config deletion +
   cruft. `~/.mattstack/rt` is then runtime-only.
5. **deck settings** + both security fixes (CF token → S; git-tracked
   data/settings.json untracked + rotated).
6. **board settings** (largest consumer surgery: three config writers rehomed;
   .env SLACK_TOKEN → S).
7. **gitq settings** + dead-code deletion.
8. **H2 — snapshot daemon** (RT-30 daemon half: watcher, owners, janitor). After
   the stores are the source of truth so it snapshots the real layer.
9. **R — restore + materialize** (RT-31): the program's acceptance test; also
   closes MAT-375's residue (strata now live in the home repo).

Sequencing flag (not this program): MAT-30/MAT-376 org creation — if the home
repo should live in the final org, create the org before H1, or provision under
m4ttheweric and `git remote set-url` later (cheap; recommended, don't block).

## Rulings ratified in conversation (Matt, 2026-08-20 — proceed; veto any in flight)

1. `rt settings linear team`: delete the surface (recommended — write-only) or park?
2. `rt.hooks` deferral out of this lane (recommended) — OK?
3. Deck git-history rewrite for the committed password hashes/secret: rotate-only
   (recommended minimum) or also rewrite history?
4. Board `members` at team scope with per-user `hidden` overlay at user scope —
   confirm the roster is team truth (config.team.json's 16) not config.json's 8.
5. Resolver extraction target: grow `@mattstack/rt-client` (recommended — board
   and gitq already depend on it) vs a new `@mattstack/settings` package.
