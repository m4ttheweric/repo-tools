import { useEffect, useMemo, useState } from "react";
import { useProcesses } from "./hooks/useProcesses.ts";
import { useRepos } from "./hooks/useRepos.ts";
import { WorktreeCard } from "./components/WorktreeCard.tsx";
import { ProcessRow } from "./components/ProcessRow.tsx";
import { EndpointBar } from "./components/EndpointBar.tsx";
import { Button } from "@/components/ui/button";

export function App() {
  const { processes, connected, error, refresh } = useProcesses();
  const { repos, error: reposError, refresh: refreshRepos } = useRepos();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const byWorktree = useMemo(() => {
    const m = new Map<string, typeof processes>();
    for (const p of processes) {
      const key = p.worktree ?? "";
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(p);
    }
    return m;
  }, [processes]);

  const knownWorktrees = useMemo(
    () => new Set(repos.flatMap((r) => r.worktrees.map((w) => w.path))),
    [repos],
  );
  const orphans = processes.filter((p) => !p.worktree || !knownWorktrees.has(p.worktree));
  const runningCount = processes.filter((p) => p.state === "running").length;
  const reload = () => { void refresh(); void refreshRepos(); };

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">rt · mission control</h1>
          <p className="text-sm text-muted-foreground">
            {repos.length} repos · {processes.length} processes · {runningCount} running
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className={`size-2 rounded-full ${connected ? "bg-sel-green" : "bg-sel-red"}`} />
            {connected ? "live" : "disconnected"}
          </span>
          <Button size="sm" variant="outline" onClick={reload}>Refresh</Button>
        </div>
      </header>

      {(error || reposError) && (
        <div className="mb-6 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error || reposError} — is the rt daemon running?
        </div>
      )}

      {repos.length === 0 && !reposError && (
        <p className="text-sm text-muted-foreground">
          No repos tracked yet. Add one with <code className="text-sel-cyan">rt</code> and it'll appear here.
        </p>
      )}

      <div className="space-y-8">
        {repos.map((r) => (
          <section key={r.repo}>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{r.repo}</h2>
            <EndpointBar repo={r.repo} processes={processes.filter((p) => p.repo === r.repo)} />
            <div className="space-y-3">
              {r.worktrees.map((wt) => (
                <WorktreeCard
                  key={wt.path}
                  worktree={wt}
                  processes={byWorktree.get(wt.path) ?? []}
                  now={now}
                  onLaunched={reload}
                />
              ))}
            </div>
          </section>
        ))}

        {orphans.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">other</h2>
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {orphans.map((p) => (
                <ProcessRow key={p.id} p={p} now={now} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
