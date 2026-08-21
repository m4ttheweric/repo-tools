/**
 * Linear ticket enrichment for rt — ported from worktree-context VS Code extension.
 *
 * Enrichment strategy:
 *  1. Extract Linear ID from branch name (exact segment match → prefix match)
 *  2. If no ID found, fall back to GitLab MR title (e.g. "[ACME-1287] Add photos")
 *  3. Fetch ticket title + status from Linear GraphQL API
 *  4. Cache results in memory (5-minute TTL)
 *
 * Secrets: the sops-backed store (lib/secrets/store.ts, domain "rt") is the
 * only source. loadSecrets propagates a decrypt failure rather than
 * degrading to any other source — callers must not treat a thrown error
 * from it as "no secrets configured."
 */

import { readSecret, writeSecret, createRealSecretsExecSeam, type SecretsSeams } from "./secrets/store.ts";
import { createRealAgeKeySeam } from "./home/age-key.ts";

// ─── Secrets ─────────────────────────────────────────────────────────────────

const RT_SECRET_DOMAIN = "rt";

interface Secrets {
  linearApiKey?: string;
  gitlabToken?: string;
  /** For forge-token reads (secrets:forge-token); nothing in rt itself calls GitHub yet. */
  githubToken?: string;
  linearTeamId?: string;
  linearTeamKey?: string;
  sdmEmail?: string;
}

const RT_SECRET_KEYS: (keyof Secrets)[] = [
  "linearApiKey", "gitlabToken", "githubToken", "linearTeamId", "linearTeamKey", "sdmEmail",
];

let realSecretsSeamsSingleton: SecretsSeams | null = null;

/** Lazily-built real seams, shared across calls in one process (readSecret memoizes per domain on top of this). */
function defaultSecretsSeams(): SecretsSeams {
  return realSecretsSeamsSingleton ??= {
    ageKeySeam: createRealAgeKeySeam(),
    execSeam: createRealSecretsExecSeam(),
  };
}

interface EncryptedRtSecretsResult {
  values: Partial<Secrets>;
  /** Set when a decrypt attempt threw (keychain unreachable, corrupt ciphertext, …) — loadSecrets decides whether that's fatal. */
  failure?: Error;
}

/**
 * Loops per key rather than one bulk call because `Secrets` has no "read the
 * whole domain" shape — but the decrypt itself is all-or-nothing per FILE,
 * not per key: `readSecret`'s per-domain memo means every key after the
 * first is a cheap object-property lookup, so a decrypt failure always
 * surfaces on the very first key attempted. Returning immediately on that
 * first failure (instead of looping through the rest) just skips five
 * guaranteed-identical failures against the same broken read — it is not
 * "returning partial data," since a real decrypt failure never leaves any.
 */
async function readEncryptedRtSecrets(seams: SecretsSeams): Promise<EncryptedRtSecretsResult> {
  const values: Partial<Secrets> = {};
  for (const key of RT_SECRET_KEYS) {
    try {
      const value = await readSecret(RT_SECRET_DOMAIN, key, seams);
      if (value !== null) values[key] = value;
    } catch (err) {
      return { values, failure: err instanceof Error ? err : new Error(String(err)) };
    }
  }
  return { values };
}

/**
 * A FAILED encrypted read (the store's own fail-closed contract —
 * NoAgeKeyError, keychain-unreachable, corrupt ciphertext) propagates
 * rather than resolving to `{}`: every direct caller either wraps this in
 * its own try/catch or runs under a seam that already logs a thrown
 * rejection (CLI dispatch, daemon handleCommand), so swallowing it here
 * would only turn a broken store into indistinguishable-from-unconfigured
 * secrets.
 */
export async function loadSecrets(seams: SecretsSeams = defaultSecretsSeams()): Promise<Secrets> {
  const { values, failure } = await readEncryptedRtSecrets(seams);
  if (failure) throw failure;
  return values;
}

export async function saveSecret(
  key: keyof Secrets,
  value: string,
  seams: SecretsSeams = defaultSecretsSeams(),
): Promise<void> {
  await writeSecret(RT_SECRET_DOMAIN, key, value, seams);
}

// ─── Branch parser ───────────────────────────────────────────────────────────

const LINEAR_ID_RE = /^[A-Za-z]+-\d+$/;
const PREFIX_RE = /^([A-Za-z]+-\d+)[-_]/;

/**
 * Extract a Linear ticket identifier from a git branch name.
 * Pass 1: exact segment match (e.g. "feature/acme-1287" → "ACME-1287")
 * Pass 2: prefix match (e.g. "feature/acme-1287-add-photos" → "ACME-1287")
 */
export function extractLinearId(branch: string): string | null {
  const segments = branch.split("/");

  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    if (LINEAR_ID_RE.test(seg)) return seg.toUpperCase();
  }

  for (let i = segments.length - 1; i >= 0; i--) {
    const match = PREFIX_RE.exec(segments[i]!);
    if (match) return match[1]!.toUpperCase();
  }

  return null;
}



// ─── Linear GraphQL API ─────────────────────────────────────────────────────

const GRAPHQL_URL = "https://api.linear.app/graphql";

export interface LinearTicket {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  stateName: string | null;
  stateColor: string | null;
  branchName: string | null;
}

async function linearGraphql(apiKey: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) throw new Error(`Linear API ${response.status}`);

  const json = (await response.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors[0]!.message);
  return json.data;
}

function toTicket(raw: Record<string, unknown>): LinearTicket {
  const state = raw.state as { name: string; color: string } | null;
  return {
    id: raw.id as string,
    identifier: raw.identifier as string,
    title: raw.title as string,
    description: (raw.description as string) ?? null,
    url: raw.url as string,
    stateName: state?.name ?? null,
    stateColor: state?.color ?? null,
    branchName: (raw.branchName as string) ?? null,
  };
}

/**
 * Fetch multiple Linear tickets in a single GraphQL request using aliased fields.
 * Each identifier gets its own `issue(id:)` lookup — all resolved in one HTTP round-trip.
 *
 * Returns a Map of uppercase identifier → LinearTicket.
 */
export async function fetchTicketsBatch(
  apiKey: string,
  identifiers: string[],
): Promise<Map<string, LinearTicket>> {
  const results = new Map<string, LinearTicket>();
  if (!identifiers.length) return results;

  // Build a single query with aliased fields:
  //   query Batch {
  //     i0: issue(id: "ACME-1403") { id identifier title description url branchName state { name color } }
  //     i1: issue(id: "ACME-1386") { id identifier title description url branchName state { name color } }
  //     ...
  //   }
  const fields = identifiers.map(
    (id, idx) => `i${idx}: issue(id: "${id}") { id identifier title description url branchName state { name color } }`,
  );
  const query = `query Batch { ${fields.join("\n")} }`;

  try {
    const data = (await linearGraphql(apiKey, query, {})) as Record<string, Record<string, unknown> | null>;

    for (let idx = 0; idx < identifiers.length; idx++) {
      const raw = data[`i${idx}`];
      if (raw && raw.id) {
        const ticket = toTicket(raw);
        results.set(ticket.identifier.toUpperCase(), ticket);
      }
    }
  } catch {
    // Batch fetch failed — caller will use cached data gracefully
  }

  return results;
}




// ─── Team configuration ─────────────────────────────────────────────────────

const TEAMS_QUERY = `
  query Teams {
    teams { nodes { id key name } }
  }
`;

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export async function fetchTeams(apiKey: string): Promise<LinearTeam[]> {
  try {
    const data = (await linearGraphql(apiKey, TEAMS_QUERY, {})) as {
      teams: { nodes: Array<{ id: string; key: string; name: string }> };
    };
    return data.teams.nodes;
  } catch {
    return [];
  }
}

export async function getTeamConfig(
  seams: SecretsSeams = defaultSecretsSeams(),
): Promise<{ teamId: string; teamKey: string } | null> {
  const secrets = await loadSecrets(seams);
  if (secrets.linearTeamId && secrets.linearTeamKey) {
    return { teamId: secrets.linearTeamId, teamKey: secrets.linearTeamKey };
  }
  return null;
}

export async function saveTeamConfig(
  teamId: string,
  teamKey: string,
  seams: SecretsSeams = defaultSecretsSeams(),
): Promise<void> {
  await writeSecret(RT_SECRET_DOMAIN, "linearTeamId", teamId, seams);
  await writeSecret(RT_SECRET_DOMAIN, "linearTeamKey", teamKey, seams);
}

// ─── Fetch team tickets ──────────────────────────────────────────────────────

// Tickets eligible for branch creation: assigned to the viewer, on the
// configured team, in any not-yet-done state. Scoped to `assignee.isMe` so the
// list is your own small set rather than the whole team's backlog — the old
// query fetched the entire team's active issues capped at 50 by recency, which
// silently dropped your own older tickets behind the team's churn. Capped high
// (Linear's max page size) and ordered by recency for good measure.
const MY_TEAM_TODO_ISSUES_QUERY = `
  query MyTeamTodoIssues($teamId: String!) {
    team(id: $teamId) {
      issues(
        filter: {
          assignee: { isMe: { eq: true } }
          state: { type: { in: ["unstarted", "backlog", "started"] } }
        }
        first: 250
        orderBy: updatedAt
      ) {
        nodes {
          id identifier title description url branchName
          state { name color }
        }
      }
    }
  }
`;

export async function fetchMyTodoTickets(apiKey: string, teamId: string): Promise<LinearTicket[]> {
  try {
    const data = (await linearGraphql(apiKey, MY_TEAM_TODO_ISSUES_QUERY, { teamId })) as {
      team: {
        issues: {
          nodes: Array<Record<string, unknown>>;
        };
      };
    };
    return data.team.issues.nodes.map(toTicket);
  } catch {
    return [];
  }
}

const SEARCH_ISSUES_FOR_BRANCH_QUERY = `
  query SearchIssuesForBranch($term: String!) {
    searchIssues(term: $term, first: 25) {
      nodes {
        id identifier title description url branchName
        state { name color }
      }
    }
  }
`;

/**
 * Full-text search across every issue the viewer can see — any team, any
 * assignee, any state. Powers the branch picker's live-search fallback so you
 * can branch off a ticket that isn't in your own active list (a teammate's
 * ticket, an unassigned one, or one in another team). Matches identifiers
 * ("ACME-2256"), bare numbers ("2256"), and title/description text.
 */
export async function searchTickets(apiKey: string, term: string): Promise<LinearTicket[]> {
  const trimmed = term.trim();
  if (!trimmed) return [];
  try {
    const data = (await linearGraphql(apiKey, SEARCH_ISSUES_FOR_BRANCH_QUERY, { term: trimmed })) as {
      searchIssues: { nodes: Array<Record<string, unknown>> };
    };
    return data.searchIssues.nodes.map(toTicket);
  } catch {
    return [];
  }
}

// ─── Workflow state selection ────────────────────────────────────────────────

interface WorkflowState {
  id: string;
  type: string;
  position: number;
}

/**
 * Pick the workflow state to move a ticket into when it's claimed ("In Progress").
 *
 * Linear lets many workflow states share `type: "started"` (e.g. Acme has
 * "In Progress", "Code Review", "Ready for Merge", … all typed `started`). The
 * raw API order is arbitrary, so picking the *first* started state can land a
 * freshly-claimed ticket in "Ready for Merge". The entry point into the started
 * group is the one with the lowest `position`, so choose that.
 */
export function pickStartedState<T extends WorkflowState>(states: T[]): T | null {
  const started = states.filter((s) => s.type === "started");
  if (started.length === 0) return null;
  return started.reduce((lowest, s) => (s.position < lowest.position ? s : lowest));
}
