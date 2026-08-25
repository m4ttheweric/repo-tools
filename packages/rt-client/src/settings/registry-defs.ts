/**
 * The settings key TABLE (RT-47/RT-50): rt's rows, plus the suite rows
 * (deck/board/gitq/mattstack/claude) — the machinery in registry-machinery.ts
 * that reads and validates against this table does not change when rows are
 * added.
 *
 * Suite rows omit `migrated` (see registry-machinery.ts's docblock): they
 * carry no rt-legacy file to migrate from, so `isMigrated()` treats the
 * absent flag as resolver-backed from day one.
 */

import type { SettingDef, SettingScope } from "./registry-machinery.ts";

const ALL_SCOPES: SettingScope[] = ["user", "team", "machine"];

export const REGISTRY: readonly SettingDef[] = [
  // --- migrated:true (wave 1) ---------------------------------------------
  {
    key: "rt.roles",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    repoScoped: true,
    migrated: true,
    pathGuardFields: ["hook"],
    description: "Per-repo dev-role definitions: port pools, env passthrough, and the dev-server hook command.",
  },
  {
    key: "rt.intercepts",
    type: "array",
    scopes: ALL_SCOPES,
    merge: "replace",
    repoScoped: true,
    migrated: true,
    description: "Per-repo endpoint intercept rules consumed by rt intercept install.",
  },
  {
    key: "rt.worktrees",
    type: "object",
    scopes: ALL_SCOPES,
    default: { onDeck: 0 },
    merge: "deep",
    repoScoped: true,
    migrated: true,
    description: "Per-repo worktree pool config (onDeck size, ready steps, name pool); root/branchFormat/ready computed-or-empty in the reader.",
  },
  {
    key: "rt.repoIdentityOverrides",
    type: "object",
    scopes: ["machine"],
    merge: "replace",
    migrated: true,
    description: "Map of observed remote URL to pinned repo identity, for forks/multi-remote repos on this machine.",
  },
  {
    key: "rt.repoRoots",
    type: "array",
    scopes: ["machine"],
    default: [],
    merge: "replace",
    migrated: true,
    description:
      'Directories rt scans for git repos (rt cd, run-outside-a-repo pickers). Entries may start with "~/" or use "${home}". One level deep, plus worktree-pool parent folders one level deeper.',
  },
  {
    key: "rt.notifications",
    type: "object",
    scopes: ["user"],
    merge: "deep",
    migrated: true,
    description: "Desktop notification preferences (which events notify, sound on/off).",
  },
  {
    key: "rt.cron",
    type: "object",
    scopes: ["machine"],
    merge: "deep",
    migrated: true,
    description: "Scheduled rt job definitions and their cron expressions. Restart the daemon to apply changes.",
  },
  {
    key: "rt.repoTracking",
    type: "object",
    scopes: ["machine"],
    merge: "deep",
    migrated: true,
    description: "Which repos rt tracks for background sync and status polling.",
  },
  {
    key: "rt.runsPruneDays",
    type: "number",
    scopes: ["machine"],
    default: 30,
    merge: "replace",
    migrated: true,
    description: "Age floor in days for pruning finished pipeline run directories under ~/.mattstack/runs (default 30).",
  },
  {
    key: "rt.runaway",
    type: "object",
    scopes: ["machine"],
    merge: "deep",
    migrated: true,
    description: "Thresholds for the runaway-process guard that kills stuck dev servers. Restart the daemon to apply changes.",
  },
  {
    key: "rt.workspacePrefs",
    type: "object",
    scopes: ["machine"],
    merge: "deep",
    migrated: true,
    description: "Per-machine editor/terminal preferences applied when opening a worktree.",
  },
  {
    key: "rt.homeSnapshot",
    type: "object",
    scopes: ["machine"],
    default: { enabled: true, debounceSec: 20, pushDelaySec: 60, janitorThresholdHours: 6, janitorIntervalMin: 30 },
    merge: "deep",
    migrated: true,
    description: "Home-repo snapshot daemon config: enabled, debounce/push delays, and the janitor threshold/interval for zones left dirty too long.",
  },
  {
    key: "rt.sync",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    repoScoped: true,
    migrated: true,
    description: "Branch sync behavior: fast-forward rules and stale-branch handling.",
  },
  {
    key: "rt.branchNaming",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    repoScoped: true,
    migrated: true,
    description: "Branch-naming templates, repoScoped. Read by the VS Code extension (extensions/vscode/rt-context), which lazily imports the legacy repos/<repo>/branch-naming.json into this key on first read; rt itself has no CLI-side reader.",
  },
  {
    key: "rt.variations",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    repoScoped: true,
    migrated: true,
    description: "Named parameter sets rt run can pick between for a command.",
  },
  {
    key: "rt.presets",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    repoScoped: true,
    migrated: true,
    description: "Saved argument presets for frequently repeated rt commands, keyed by name.",
  },
  {
    key: "rt.dopplerTemplate",
    type: "array",
    scopes: ALL_SCOPES,
    merge: "replace",
    repoScoped: true,
    migrated: true,
    description: "Template used to generate a repo's Doppler secrets config.",
  },

  // --- wave 2 (ownership-latch ports, RT-53) ------------------------------
  // These rows carry NO `default`: the ownership latch is `getSetting(key)
  // .value === undefined`, and a registry default materializes as a present
  // value — adding one flips the key store-authoritative on every install
  // (same invariant as the board.* block above).
  {
    key: "rt.worktreeApp",
    type: "object",
    scopes: ["machine"],
    merge: "deep",
    migrated: true,
    description: "Machine-local worktree feature toggle (enabled, killProcesses); ownership-latch port of ~/.mattstack/rt/worktrees.json, store wins per field. A distinct key from rt.worktrees (the per-repo pool config above) on purpose — same file family, unrelated shape and scope.",
  },
  {
    key: "rt.sdmEnrichment",
    type: "object",
    scopes: ["team"],
    merge: "replace",
    migrated: true,
    description: "Team-declared StrongDM resource enrichment (resource name -> label/tier/db/reasonSuggestion); team-ONLY by design, enrichment names employer resources and must never be settable in a user or machine store. Ownership-latch port of ~/.mattstack/rt/sdm/enrichment.jsonc, store wins wholesale (a name-keyed map, not a field-bag).",
  },
  {
    key: "rt.logRetentionDays",
    type: "number",
    scopes: ["machine", "user"],
    default: 14,
    merge: "replace",
    migrated: true,
    description: "Age floor in days for the log janitor pruning every surface's rotated log files under ~/.mattstack/rt/logs (default 14). A fresh key, not an ownership-latch port, so a default is fine here.",
  },
  {
    key: "rt.hooks",
    type: "object",
    scopes: ALL_SCOPES,
    merge: "deep",
    repoScoped: true,
    migrated: true,
    description: "Per-repo git hook enable/disable state ({enabled, hooks: {<hookName>: boolean}}); ownership-latch port of repos/<repo>/hooks.json, store wins per field once it owns the key — including per-hook-name entries inside the nested hooks map, each defaulting to enabled when absent. The installed git-hook shim still greps repos/<repo>/hooks.json with zero process spawns (a hook fires on every git operation); that file is now a DERIVED CACHE this key writes through, kept current by commands/hooks.ts's regenerateHooksCache at every write seam.",
  },

  // --- mattstack (installer-lane) -----------------------------------------
  {
    key: "mattstack.integrations",
    type: "object",
    scopes: ["team"],
    merge: "deep",
    description: "Team-wide external integration config (forge/slack/linear/switchboard) the installer provisions; client secrets never live here.",
  },
  {
    key: "mattstack.tracking",
    type: "object",
    scopes: ["team"],
    merge: "deep",
    description: "Team-declared repo tracking intent, identity-keyed; the daemon layers it under machine-scoped rt.repoTracking, which wins per repo whenever it names that repo at all — including an explicit local {mode:\"off\"} entry, the way to opt a repo out of team-declared tracking.",
  },
  {
    key: "mattstack.appPath",
    type: "string",
    scopes: ["machine"],
    merge: "replace",
    description: "Absolute path to the installed mattstack.app bundle, written by the app at launch so rt stops hardcoding ~/Applications.",
  },
  {
    key: "mattstack.mode",
    type: "string",
    scopes: ["machine"],
    merge: "replace",
    description: "The machine's intended flavor, \"dev\" or \"prod\". Normally written by `rt settings dev-mode` after a successful handoff; a manual `rt settings set` is the blessed repair escape hatch — the daemon park loop converges on whatever this says. Unset ⇒ derived from the dev wrapper's presence.",
  },
  {
    key: "rt.integrations",
    type: "object",
    scopes: ["user"],
    merge: "deep",
    migrated: true,
    description:
      "User-confirmed integration hosts (forgeHost, switchboardUrl), written only by an explicit `rt setup <id> connect --host` after that host validates a real credential. The one trusted source a credential is ever sent to — mattstack.integrations' team-declared host is shown to the user but never auto-used for a fetch.",
  },

  // --- claude (installer-lane) --------------------------------------------
  {
    key: "claude.marketplaces",
    type: "array",
    scopes: ["user", "team"],
    merge: "replace",
    description: "Claude Code plugin marketplaces to replay on restore, in add order.",
  },
  {
    key: "claude.plugins",
    type: "array",
    scopes: ["user", "team"],
    merge: "replace",
    description: "Claude Code plugins to replay on restore, in install order.",
  },

  // --- deck (MAT-384 settings half) ---------------------------------------
  {
    key: "deck.apps",
    type: "object",
    scopes: ["user"],
    merge: "deep",
    description: "Per-app deck publish state (published flag, publicFollowsOverride); password hashes and session secrets stay out of this store.",
  },
  {
    key: "deck.access",
    type: "object",
    scopes: ["user"],
    merge: "deep",
    description: "deck's access-control roster, migrated from access.json.",
  },
  {
    key: "deck.platform",
    type: "object",
    scopes: ["machine"],
    merge: "deep",
    description: "deck's platform-level machine config: public domain and legacy URL prefixes; Cloudflare secrets stay out of this store.",
  },

  // --- board (team) --------------------------------------------------------
  // board.* rows carry NO `default`: the board's store-ownership latch is
  // `getSetting(key).value === undefined`, and a registry default materializes
  // as a present value — adding one flips that key store-authoritative on
  // every install and blanks the file's value.
  {
    key: "board.gitlabHost",
    type: "string",
    scopes: ["team"],
    merge: "replace",
    description: "GitLab host the board polls for MRs, shared by the whole team.",
  },
  {
    key: "board.projects",
    type: "array",
    scopes: ["team"],
    merge: "replace",
    description: "GitLab projects the board tracks, shared by the whole team.",
  },
  {
    key: "board.members",
    type: "array",
    scopes: ["team"],
    merge: "replace",
    description: "The board's full member roster, including hidden-by-default entries.",
  },
  {
    key: "board.title",
    type: "string",
    scopes: ["team"],
    merge: "replace",
    description: "Display title shown in the board's UI.",
  },
  {
    key: "board.botUsernames",
    type: "array",
    scopes: ["team"],
    merge: "replace",
    description: "GitLab usernames the board treats as bots, excluded from human MR attribution.",
  },
  {
    key: "board.ticketPrefixes",
    type: "array",
    scopes: ["team"],
    merge: "replace",
    description: "Ticket key prefixes (e.g. RT, MAT) the board links out to Linear from an MR title.",
  },
  {
    key: "board.slack",
    type: "object",
    scopes: ["team"],
    merge: "deep",
    description: "The board's Slack posting config (app id, client id, channel, callback port); client secrets stay out of this store.",
  },
  {
    key: "board.doctorSkill",
    type: "string",
    scopes: ["team"],
    merge: "replace",
    description: "Default doctor skill for repairing a stuck MR; a repo's skills.jsonc doctor slot overrides it when present.",
  },
  {
    key: "board.triage.doctorSkill",
    type: "string",
    scopes: ["team"],
    merge: "replace",
    description: "Doctor skill the board's own API-tier triage sweep runs on your MRs; deliberately never resolved through a repo's skills.jsonc manifest. A sibling flat key of board.triage, not a field inside it — the board reader assembles the two independently.",
  },
  {
    key: "board.tabs",
    type: "array",
    scopes: ["team"],
    merge: "replace",
    description: "Board tab definitions ({id, label, source, slackChannel?, reviewSkill?}); source.kind 'authors' is the classic roster board, 'codeowners' lists MRs blocked on an unapproved CODEOWNERS section. Absent = one implicit authors tab (fallback lives in the board reader, never here).",
  },

  // --- board (user) ----------------------------------------------------------
  {
    key: "board.staleAfterDays",
    type: "number",
    scopes: ["user"],
    merge: "replace",
    description: "Days of MR inactivity before the board flags it stale, for this developer.",
  },
  {
    key: "board.workspaces",
    type: "object",
    scopes: ["user"],
    merge: "deep",
    description: "Herdr workspace names the board's review/respond/doctor panes launch into, per developer.",
  },
  {
    key: "board.defaultMember",
    type: "string",
    scopes: ["user"],
    merge: "replace",
    description: "Which board member identity this developer's local board runs as by default.",
  },
  {
    key: "board.hiddenMembers",
    type: "array",
    scopes: ["user"],
    merge: "replace",
    description: "Usernames this developer hides from the team roster's board.members list; overlays the team truth without editing it.",
  },
  {
    key: "board.triage",
    type: "object",
    scopes: ["user"],
    merge: "deep",
    description: "This developer's triage user-intent flags (which triage sweeps run automatically); a sibling flat key of board.triage.doctorSkill, not its container — the board reader assembles the two independently.",
  },

  // --- board (machine) ---------------------------------------------------
  {
    key: "board.claudeCommand",
    type: "string",
    scopes: ["machine"],
    merge: "replace",
    description: "Local command used to launch Claude Code for the board's review/respond/doctor panes.",
  },
  {
    key: "board.cwds",
    type: "object",
    scopes: ["machine"],
    merge: "deep",
    description: "Local working directories the board's review/respond/doctor panes launch from.",
  },
  {
    key: "board.rtRepos",
    type: "array",
    scopes: ["machine"],
    merge: "replace",
    description: "rt-registered repo names the board resolves MRs against on this machine.",
  },
  {
    key: "board.triageMaxConcurrent",
    type: "number",
    scopes: ["machine"],
    merge: "replace",
    description: "Max concurrent triage panes the board launches on this machine.",
  },
  {
    key: "board.switchboardUrl",
    type: "string",
    scopes: ["machine"],
    merge: "replace",
    description: "Local switchboard URL the board's POST /peer/join writer targets.",
  },

  // --- gitq ------------------------------------------------------------------
  {
    key: "gitq.workSlots",
    type: "object",
    scopes: ["machine"],
    merge: "deep",
    description: "gitq's local work-slot config: on-disk location and the max slot count.",
  },
  {
    key: "gitq.forges",
    type: "object",
    scopes: ["user"],
    merge: "deep",
    description: "gitq's host-keyed forge config, tokenEnv names only — never a live token.",
  },
  {
    key: "gitq.board",
    type: "object",
    scopes: ["machine"],
    merge: "deep",
    description: "gitq checkout-board config: tracked repos, local port, and the herdr workspace it launches into.",
  },

  // --- chat (RT-48 Task 7) -------------------------------------------------
  {
    key: "chat.handle",
    type: "string",
    scopes: ["user"],
    merge: "replace",
    description: "Explicit rt chat handle for this developer on this machine; overrides the derived <repo>-<dir> handle when set.",
  },
  {
    key: "chat.humanHandle",
    type: "string",
    scopes: ["user"],
    default: "matt",
    merge: "replace",
    description: "The human's own chat handle, so agents can @-mention them by name.",
  },
  {
    key: "chat.push.provider",
    type: "string",
    scopes: ["user"],
    merge: "replace",
    description: "Push notification provider used to alert the human of chat mentions when away from a terminal.",
  },
  {
    key: "chat.push.target",
    type: "string",
    scopes: ["user"],
    merge: "replace",
    description: "Destination (topic/URL/token) the configured chat.push.provider sends to.",
  },
];
