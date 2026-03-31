const GRAPHQL_URL = 'https://api.linear.app/graphql';

export interface LinearTicket {
  id: string;
  identifier: string;
  title: string;
  url: string;
  stateName: string | null;
  branchName: string | null;
}

const ISSUE_BY_ID_QUERY = `
  query IssueById($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      url
      branchName
      state { name }
    }
  }
`;

const SEARCH_ISSUES_QUERY = `
  query SearchIssues($term: String!) {
    searchIssues(term: $term, first: 5) {
      nodes {
        id
        identifier
        title
        url
        branchName
        state { name }
      }
    }
  }
`;

async function graphql(apiKey: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Linear API ${response.status}: ${response.statusText}`);
  }

  const json = (await response.json()) as { data?: unknown; errors?: Array<{ message: string }> };

  if (json.errors?.length) {
    throw new Error(`Linear API error: ${json.errors[0]!.message}`);
  }

  return json.data;
}

function toTicket(raw: Record<string, unknown>): LinearTicket {
  const state = raw.state as { name: string } | null;
  return {
    id: raw.id as string,
    identifier: raw.identifier as string,
    title: raw.title as string,
    url: raw.url as string,
    stateName: state?.name ?? null,
    branchName: (raw.branchName as string) ?? null,
  };
}

const MY_TODO_ISSUES_QUERY = `
  query MyTodoIssues {
    viewer {
      assignedIssues(
        filter: {
          state: { type: { in: ["unstarted", "backlog"] } }
          attachments: { or: [{ length: { eq: 0 } }, { url: { notContains: "github.com" } }] }
        }
        first: 50
        orderBy: updatedAt
      ) {
        nodes {
          id
          identifier
          title
          url
          branchName
          state { name }
          attachments { nodes { url } }
        }
      }
    }
  }
`;

/**
 * Fetch a Linear issue by its identifier (e.g. "CV-1287").
 * Falls back to search if direct lookup fails.
 */
export async function fetchTicket(apiKey: string, identifier: string): Promise<LinearTicket | null> {
  try {
    const data = (await graphql(apiKey, ISSUE_BY_ID_QUERY, { id: identifier })) as {
      issue: Record<string, unknown> | null;
    };
    if (data.issue) {
      return toTicket(data.issue);
    }
  } catch {
    // Direct lookup failed — try search as fallback
  }

  try {
    const data = (await graphql(apiKey, SEARCH_ISSUES_QUERY, { term: identifier })) as {
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
 * Fetch the viewer's assigned issues in To Do / Backlog state
 * that do not yet have a git branch linked.
 */
export async function fetchMyTodoTickets(apiKey: string): Promise<LinearTicket[]> {
  try {
    const data = (await graphql(apiKey, MY_TODO_ISSUES_QUERY, {})) as {
      viewer: {
        assignedIssues: {
          nodes: Array<Record<string, unknown> & { attachments: { nodes: Array<{ url: string }> } }>;
        };
      };
    };

    // Client-side filter: skip tickets that have a branch-like attachment (GitHub/GitLab link)
    return data.viewer.assignedIssues.nodes
      .filter((n) => {
        const attachments = n.attachments?.nodes ?? [];
        const hasBranchLink = attachments.some(
          (a) => a.url && (/github\.com/.test(a.url) || /gitlab\.com/.test(a.url)),
        );
        return !hasBranchLink;
      })
      .map(toTicket);
  } catch {
    return [];
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
  //     i0: issue(id: "CV-1403") { id identifier title url branchName state { name } }
  //     i1: issue(id: "CV-1386") { id identifier title url branchName state { name } }
  //     ...
  //   }
  const fields = identifiers.map(
    (id, idx) => `i${idx}: issue(id: "${id}") { id identifier title url branchName state { name } }`,
  );
  const query = `query Batch { ${fields.join('\n')} }`;

  try {
    const data = (await graphql(apiKey, query, {})) as Record<string, Record<string, unknown> | null>;

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
