// apps/dashboard/src/components/WorktreeCard.tsx
import { useMemo, useState } from "react";
import { SquareTerminal, ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CommandDialog } from "@/components/ui/command";
import { SessionTabs } from "./SessionTabs.tsx";
import { SessionTerminal } from "./SessionTerminal.tsx";
import { SessionControlBar } from "./SessionControlBar.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { controlProcess, createProcess, createTerminal, fetchWorktreeCommands, removeProcess } from "../lib/api.ts";
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

  // Derive the active session (don't force-reset activeId in an effect — that
  // races a just-launched id that hasn't appeared in the polled list yet and
  // bounces focus back to the previous tab). A freshly-selected id sticks; once
  // its session arrives, `active` resolves to it. Falls back to the first
  // session when the selected one is gone (e.g. closed).
  const active = sessions.find((s) => s.id === activeId) ?? sessions[0] ?? null;

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

  // Close a tab entirely: kill the session if running, then drop its bookkeeping
  // so the tab disappears (for both shells and dev commands).
  const closeSession = async (id: string) => {
    try {
      await controlProcess(id, "stop");
      await removeProcess(id);
      onLaunched();
    } catch (e) {
      alert(`close failed: ${e}`);
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
        <Button size="sm" variant="ghost" className="gap-1.5" onClick={openTerminal} disabled={openingTerminal}>
          <SquareTerminal /> New Terminal Session
        </Button>
      </div>

      {/* Console: the tab strip is always visible (the at-a-glance overview);
          the control bar + terminal mount only when this card is expanded, so
          collapsing unmounts the terminal and closes its attach socket. */}
      <div className="dark border-t border-border bg-background">
        <div className="bg-card">
          <SessionTabs
            sessions={sessions}
            activeId={active?.id ?? null}
            onSelect={expanded ? setActiveId : selectAndExpand}
            onClose={closeSession}
            onPickCommand={() => onPaletteOpenChange(true)}
          />
        </div>
        {expanded && active && <SessionControlBar session={active} now={now} onChanged={onLaunched} />}
        {expanded && active && <SessionTerminal key={active.id} id={active.id} />}
      </div>

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
