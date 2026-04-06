/**
 * Linear ticket enrichment for rt — ported from worktree-context VS Code extension.
 *
 * Enrichment strategy:
 *  1. Extract Linear ID from branch name (exact segment match → prefix match)
 *  2. If no ID found, fall back to GitLab MR title (e.g. "[CV-1287] Add photos")
 *  3. Fetch ticket title + status from Linear GraphQL API
 *  4. Cache results in memory (5-minute TTL)
 *
 * API keys stored in ~/.rt/secrets.json
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Secrets ─────────────────────────────────────────────────────────────────

const SECRETS_PATH = join(homedir(), ".rt", "secrets.json");

interface Secrets {
  linearApiKey?: string;
  gitlabToken?: string;
  linearTeamId?: string;
  linearTeamKey?: string;
}

export function loadSecrets(): Secrets {
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function saveSecret(key: keyof Secrets, value: string): void {
  const secrets = loadSecrets();
  secrets[key] = value;
  writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2));
}

// ─── Branch parser ───────────────────────────────────────────────────────────

const LINEAR_ID_RE = /^[A-Za-z]+-\d+$/;
const PREFIX_RE = /^([A-Za-z]+-\d+)[-_]/;

/**
 * Extract a Linear ticket identifier from a git branch name.
 * Pass 1: exact segment match (e.g. "feature/cv-1287" → "CV-1287")
 * Pass 2: prefix match (e.g. "feature/cv-1287-add-photos" → "CV-1287")
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
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  stateName: string | null;
  stateColor: string | null;
  branchName: string | null;
}

const ISSUE_BY_ID_QUERY = `
  query IssueById($id: String!) {
    issue(id: $id) {
      id identifier title description url branchName
      state { name color }
    }
  }
`;

const SEARCH_ISSUES_QUERY = `
  query SearchIssues($term: String!) {
    searchIssues(term: $term, first: 5) {
      nodes {
        id identifier title description url branchName
        state { name color }
      }
    }
  }
`;

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
    identifier: raw.identifier as string,
    title: raw.title as string,
    description: (raw.description as string) ?? null,
    url: raw.url as string,
    stateName: state?.name ?? null,
    stateColor: state?.color ?? null,
    branchName: (raw.branchName as string) ?? null,
  };
}

export async function fetchTicket(apiKey: string, identifier: string): Promise<LinearTicket | null> {
  try {
    const data = (await linearGraphql(apiKey, ISSUE_BY_ID_QUERY, { id: identifier })) as {
      issue: Record<string, unknown> | null;
    };
    if (data.issue) return toTicket(data.issue);
  } catch { /* direct lookup failed */ }

  try {
    const data = (await linearGraphql(apiKey, SEARCH_ISSUES_QUERY, { term: identifier })) as {
      searchIssues: { nodes: Array<Record<string, unknown>> };
    };
    const match = data.searchIssues.nodes.find(
      (n) => (n.identifier as string).toUpperCase() === identifier.toUpperCase(),
    );
    return match ? toTicket(match) : null;
  } catch {
    return null;
  }
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
  //     i0: issue(id: "CV-1403") { id identifier title description url branchName state { name color } }
  //     i1: issue(id: "CV-1386") { id identifier title description url branchName state { name color } }
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

export function getTeamConfig(): { teamId: string; teamKey: string } | null {
  const secrets = loadSecrets();
  if (secrets.linearTeamId && secrets.linearTeamKey) {
    return { teamId: secrets.linearTeamId, teamKey: secrets.linearTeamKey };
  }
  return null;
}

export function saveTeamConfig(teamId: string, teamKey: string): void {
  const secrets = loadSecrets();
  secrets.linearTeamId = teamId;
  secrets.linearTeamKey = teamKey;
  writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2));
}

// ─── Create issue ────────────────────────────────────────────────────────────

const CREATE_ISSUE_MUTATION = `
  mutation CreateIssue($teamId: String!, $title: String!, $description: String) {
    issueCreate(input: { teamId: $teamId, title: $title, description: $description }) {
      success
      issue {
        id identifier title description url branchName
        state { name color }
      }
    }
  }
`;

export async function createIssue(
  apiKey: string,
  teamId: string,
  title: string,
  description?: string,
): Promise<LinearTicket | null> {
  try {
    const data = (await linearGraphql(apiKey, CREATE_ISSUE_MUTATION, {
      teamId,
      title,
      description: description || undefined,
    })) as {
      issueCreate: {
        success: boolean;
        issue: Record<string, unknown> | null;
      };
    };
    if (data.issueCreate.success && data.issueCreate.issue) {
      return toTicket(data.issueCreate.issue);
    }
    return null;
  } catch (err) {
    throw new Error(`Failed to create issue: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Fetch assigned tickets ──────────────────────────────────────────────────

const MY_TODO_ISSUES_QUERY = `
  query MyTodoIssues {
    viewer {
      assignedIssues(
        filter: {
          state: { type: { in: ["unstarted", "backlog"] } }
        }
        first: 50
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

export async function fetchMyTodoTickets(apiKey: string): Promise<LinearTicket[]> {
  try {
    const data = (await linearGraphql(apiKey, MY_TODO_ISSUES_QUERY, {})) as {
      viewer: {
        assignedIssues: {
          nodes: Array<Record<string, unknown>>;
        };
      };
    };
    return data.viewer.assignedIssues.nodes.map(toTicket);
  } catch {
    return [];
  }
}
