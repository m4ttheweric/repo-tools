import { useState } from "react";
import { SquareChevronRight, SquareTerminal } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CommandDialog } from "@/components/ui/command";
import { ProcessRow } from "./ProcessRow.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { TerminalSession } from "./TerminalSession.tsx";
import { createProcess, createTerminal, fetchWorktreeCommands } from "../lib/api.ts";
import { basename } from "../lib/format.ts";
import type { FlatCommand } from "../lib/commands.ts";
import type { ProcessRecord, RepoWorktree, WorktreePackage } from "../lib/types.ts";

const LIVE = new Set(["running", "starting", "warm"]);

export function WorktreeCard({
  worktree,
  processes,
  now,
  onLaunched,
}: {
  worktree: RepoWorktree;
  processes: ProcessRecord[];
  now: number;
  onLaunched: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [packages, setPackages] = useState<WorktreePackage[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [launching, setLaunching] = useState<string | null>(null);
  const [openingTerminal, setOpeningTerminal] = useState(false);

  // Interactive shell sessions render as live terminals; everything else is a
  // dev-process row. Killed (stopped) terminals drop out of the live set.
  const terminals = processes.filter((p) => p.kind === "terminal" && LIVE.has(p.state));
  const devProcs = processes.filter((p) => p.kind !== "terminal");

  const openTerminal = async () => {
    setOpeningTerminal(true);
    try {
      await createTerminal(worktree.path);
      onLaunched();
    } catch (e) {
      alert(`failed to open terminal: ${e}`);
    } finally {
      setOpeningTerminal(false);
    }
  };

  // Lazy-load scripts the first time the spotlight is opened.
  const onOpenChange = async (next: boolean) => {
    setOpen(next);
    if (next && packages === null) {
      setLoading(true);
      try {
        setPackages(await fetchWorktreeCommands(worktree.path));
      } catch {
        setPackages([]);
      } finally {
        setLoading(false);
      }
    }
  };

  const launch = async (c: FlatCommand) => {
    const key = `${c.dir}:${c.script}`;
    setLaunching(key);
    try {
      // Launch by script name so the daemon runs it through the package manager
      // (raw script bodies fail for local bins like turbo/vite).
      await createProcess({ cwd: c.dir, script: c.script, label: c.script });
      setOpen(false);
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
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-foreground">{basename(worktree.path)}</span>
          {worktree.branch && <span className="text-sel-violet">{worktree.branch}</span>}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => onOpenChange(true)}
            aria-label="Run a command"
            title="Run a command"
          >
            <SquareChevronRight />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={openTerminal}
            disabled={openingTerminal}
            aria-label="New terminal"
            title="New terminal"
          >
            <SquareTerminal />
          </Button>
        </div>
      </div>

      {devProcs.length > 0 && (
        <div className="divide-y divide-border border-t border-border">
          {devProcs.map((p) => (
            <ProcessRow key={p.id} p={p} now={now} />
          ))}
        </div>
      )}

      {terminals.map((t) => (
        <TerminalSession key={t.id} id={t.id} onKilled={onLaunched} />
      ))}

      {/* Spotlight-style command palette: top third of the screen, themed dark
          to read like a console. */}
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        className="dark top-[12%] translate-y-0 sm:max-w-3xl"
        title={`Run a command — ${basename(worktree.path)}`}
        description="Search and launch a package script in this worktree"
      >
        {/* Visible header carries the clicked worktree's context into the dialog. */}
        <div className="flex items-baseline gap-2 border-b border-border px-4 py-3 text-sm">
          <span className="shrink-0 font-medium whitespace-nowrap text-foreground">{basename(worktree.path)}</span>
          {worktree.branch && <span className="truncate font-mono text-xs text-sel-violet">{worktree.branch}</span>}
        </div>
        {loading && <p className="p-6 text-sm text-muted-foreground">discovering scripts…</p>}
        {packages && packages.length === 0 && (
          <p className="p-6 text-sm text-muted-foreground">No package scripts found in this worktree.</p>
        )}
        {packages && packages.length > 0 && (
          <CommandPalette packages={packages} busyKey={launching} onRun={launch} />
        )}
      </CommandDialog>
    </Card>
  );
}
