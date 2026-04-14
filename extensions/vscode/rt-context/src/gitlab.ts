import { GitLabProvider } from '@workforge/glance-sdk';
import { parseRemoteUrl } from './branchParser';

/**
 * Regex to find a Linear-style identifier (TEAM-NNN) in a string.
 * Used for parsing MR titles like "[CV-1287] Add damage photos".
 */
const LINEAR_ID_IN_TEXT = /\b([A-Za-z]+-\d+)\b/;

export interface MRLookupResult {
  webUrl: string | null;
  linearId: string | null;
}

/**
 * Find an open MR for the given branch using the glance-sdk GitLabProvider.
 * Returns the MR web URL and, if present, a Linear ticket ID extracted
 * from the MR title.
 */
export async function fetchMRInfo(
  gitlabToken: string,
  remoteUrl: string,
  branchName: string,
): Promise<MRLookupResult | null> {
  const remote = parseRemoteUrl(remoteUrl);
  if (!remote) return null;

  try {
    const provider = new GitLabProvider(remote.host, gitlabToken);
    const mr = await provider.fetchPullRequestByBranch(remote.projectPath, branchName);

    if (!mr) return null;

    const match = LINEAR_ID_IN_TEXT.exec(mr.title);
    return {
      webUrl: mr.webUrl,
      linearId: match ? match[1]!.toUpperCase() : null,
    };
  } catch {
    return null;
  }
}

/**
 * Batch-fetch MR info for multiple branches in a single API call.
 * Returns a map of branch name → MRLookupResult for branches that have an open MR.
 */
export async function fetchMRInfoBatch(
  gitlabToken: string,
  remoteUrl: string,
  branches: string[],
): Promise<Map<string, MRLookupResult>> {
  const results = new Map<string, MRLookupResult>();
  if (!branches.length) return results;

  const remote = parseRemoteUrl(remoteUrl);
  if (!remote) return results;

  try {
    const provider = new GitLabProvider(remote.host, gitlabToken);
    const mrMap = await provider.fetchPullRequestsByBranches(remote.projectPath, branches);

    for (const [branch, mr] of mrMap) {
      if (!mr) continue;
      const match = LINEAR_ID_IN_TEXT.exec(mr.title);
      results.set(branch, {
        webUrl: mr.webUrl,
        linearId: match ? match[1]!.toUpperCase() : null,
      });
    }
  } catch {
    // Batch fetch failed — caller falls back to cached data
  }

  return results;
}
