import { useCallback, useEffect, useState } from "react";
import { fetchRepos } from "../lib/api.ts";
import type { RepoInfo } from "../lib/types.ts";

/** Loads the tracked repos + their worktrees (independent of what's running). */
export function useRepos() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRepos(await fetchRepos());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { repos, error, refresh };
}
