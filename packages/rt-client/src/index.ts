export { rtCommand, DEFAULT_SOCK } from "./transport.ts";
export type { RtResponse, RtClientOptions } from "./transport.ts";

export {
  readProjectMRs,
  readDiscussions,
  readMrsByBranch,
  readBranchCache,
  resolveForgeToken,
  listRuns,
  getRun,
  abandonRun,
  chatJoin,
  chatLeave,
  chatPost,
  chatRead,
  chatRooms,
  chatWho,
  chatMark,
  chatMessages,
  chatArm,
  chatTouch,
  chatDisarm,
  chatUnreadWaking,
  chatSignIn,
  chatSignOut,
  chatAway,
  chatBack,
  chatBuddies,
  chatPulse,
  chatDm,
  eventsHead,
  agentStart,
  agentResume,
  agentGet,
  agentList,
} from "./client.ts";

export { COMMAND_NAMES } from "./commands.ts";
export type {
  Discussion,
  DemandDecl,
  ProjectMRsScope,
  ProjectMRsData,
  DiscussionsData,
  MrByBranchEntry,
  MrByBranchData,
  BranchEnrichment,
  Commands,
  CommandName,
  ForgeSlug,
  ForgeTokenData,
  Attention,
  RunSummary,
  RunStageRow,
  RunFieldRow,
  RunDecisionRow,
  RunDetail,
  WakeMode,
  ChatMember,
  ChatMessage,
  RoomSummary,
  BuddyStatus,
  PresenceRow,
  AgentRecord,
  AgentSurface,
} from "./commands.ts";

export { subscribe, createRelay, DEFAULT_WS_URL } from "./relay.ts";
export type { RelayEventType } from "./relay.ts";

export { daemonHealth } from "./health.ts";

export { repoNameForPath } from "./repos.ts";

// ─── Settings (RT-50) ────────────────────────────────────────────────────────

export { getSetting, listSettings, explainSetting, expandVariables, SCOPE_ORDER } from "./settings/resolve.ts";
export type {
  Scope,
  Provenance,
  ResolveOpts,
  Resolved,
  InvalidScope,
  ListedSetting,
  ExplainRow,
  ExpandCtx,
} from "./settings/resolve.ts";

export { setSetting, unsetSetting } from "./settings/write.ts";
export type { SetSettingOpts } from "./settings/write.ts";

export { getDef, allDefs, validateValue, isMigrated } from "./settings/registry-machinery.ts";
export type { SettingDef, SettingScope } from "./settings/registry-machinery.ts";
export { REGISTRY } from "./settings/registry-defs.ts";

export { readStore, listTeams } from "./settings/stores.ts";
export type { StoreFile } from "./settings/stores.ts";

export {
  normalizeRemote, identityFromRemote, deriveRepoIdentity, clearIdentityMemo,
  serializeIdentity, parseIdentity, resolveNameToIdentity,
  type RepoIdentity,
} from "./settings/identity.ts";
