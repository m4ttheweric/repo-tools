// apps/dashboard/src/components/WorktreeCard.tsx
import { useEffect, useMemo, useState } from "react";
import { SquareChevronRight, SquareTerminal, ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CommandDialog } from "@/components/ui/command";
import { SessionTabs } from "./SessionTabs.tsx";
import { SessionTerminal } from "./SessionTerminal.tsx";
import { SessionControlBar } from "./SessionControlBar.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { createProcess, createTerminal, fetchWorktreeCommands } from "../lib/api.ts";
import { basename } from "../lib/format.ts";
import { sessionsForWorktree } from "../lib/sessions.ts";
import type { FlatCommand } from "../lib/commands.ts";
import type { ProcessRecord, RepoWorktree, WorktreePackage } from "../lib/types.ts";

export function WorktreeCard({
  worktree,
  processes,
  now,
  onLaunched,
  expanded,
  onExpand,
}: {
  worktree: RepoWorktree;
  processes: ProcessRecord[];
  now: number;
  onLaunched: () => void;
  expanded: boolean;
  onExpand: (path: string | null) => void;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [packages, setPackages] = useState<WorktreePackage[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [launching, setLaunching] = useState<string | null>(null);
  const [openingTerminal, setOpeningTerminal] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sessions = useMemo(() => sessionsForWorktree(processes), [processes]);

  // Keep activeId valid: default to the first session; clear when none remain.
  useEffect(() => {
    if (sessions.length === 0) { if (activeId) setActiveId(null); return; }
    if (!activeId || !sessions.some((s) => s.id === activeId)) setActiveId(sessions[0]!.id);
  }, [sessions, activeId]);

  const selectAndExpand = (id: string) => { setActiveId(id); onExpand(worktree.path); };

  const openTerminal = async () => {
    setOpeningTerminal(true);
    try {
      const id = await createTerminal(worktree.path);
      selectAndExpand(id);
      onLaunched();
    } catch (e) {
      alert(`failed to open terminal: ${e}`);
    } finally {
      setOpeningTerminal(false);
    }
  };

  const onPaletteOpenChange = async (next: boolean) => {
    setPaletteOpen(next);
    if (next && packages === null) {
      setLoading(true);
      try { setPackages(await fetchWorktreeCommands(worktree.path)); }
      catch { setPackages([]); }
      finally { setLoading(false); }
    }
  };

  const launch = async (c: FlatCommand) => {
    const key = `${c.dir}:${c.script}`;
    setLaunching(key);
    try {
      const id = await createProcess({ cwd: c.dir, script: c.script, label: c.script });
      setPaletteOpen(false);
      selectAndExpand(id);
      onLaunched();
    } catch (e) {
      alert(`launch failed: ${e}`);
    } finally {
      setLaunching(null);
    }
  };

  const active = sessions.find((s) => s.id === activeId) ?? null;

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex items-center justify-between px-4 py-2">
        <button
          className="flex items-center gap-2 text-xs"
          onClick={() => onExpand(expanded ? null : worktree.path)}
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
          <span className="font-medium text-foreground">{basename(worktree.path)}</span>
          {worktree.branch && <span className="text-sel-violet">{worktree.branch}</span>}
        </button>
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" onClick={() => onPaletteOpenChange(true)} aria-label="Run a command" title="Run a command">
            <SquareChevronRight />
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={openTerminal} disabled={openingTerminal} aria-label="New terminal" title="New terminal">
            <SquareTerminal />
          </Button>
        </div>
      </div>

      {sessions.length > 0 && (
        <div className="dark border-t border-border bg-background" style={{ display: expanded ? undefined : "none" }}>
          <SessionTabs sessions={sessions} activeId={activeId} onSelect={setActiveId} />
          {active && <SessionControlBar session={active} now={now} onChanged={onLaunched} />}
          {active && <SessionTerminal key={active.id} id={active.id} />}
        </div>
      )}

      {sessions.length > 0 && !expanded && (
        <div className="dark border-t border-border bg-background">
          <SessionTabs sessions={sessions} activeId={activeId} onSelect={selectAndExpand} />
        </div>
      )}

      {sessions.length === 0 && (
        <div className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          no sessions — use the run or terminal buttons
        </div>
      )}

      <CommandDialog
        open={paletteOpen}
        onOpenChange={onPaletteOpenChange}
        className="dark top-[12%] translate-y-0 sm:max-w-3xl"
        title={`Run a command — ${basename(worktree.path)}`}
        description="Search and launch a package script in this worktree"
      >
        <div className="flex items-baseline gap-2 border-b border-border px-4 py-3 text-sm">
          <span className="shrink-0 font-medium whitespace-nowrap text-foreground">{basename(worktree.path)}</span>
          {worktree.branch && <span className="truncate font-mono text-xs text-sel-violet">{worktree.branch}</span>}
        </div>
        {loading && <p className="p-6 text-sm text-muted-foreground">discovering scripts…</p>}
        {packages && packages.length === 0 && <p className="p-6 text-sm text-muted-foreground">No package scripts found in this worktree.</p>}
        {packages && packages.length > 0 && <CommandPalette packages={packages} busyKey={launching} onRun={launch} />}
      </CommandDialog>
    </Card>
  );
}
