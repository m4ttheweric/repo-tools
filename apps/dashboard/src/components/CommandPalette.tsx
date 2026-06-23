import { useEffect, useMemo, useRef, useState } from "react";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { fuzzyFilter } from "../lib/fuzzy.ts";
import { flattenCommands, type FlatCommand } from "../lib/commands.ts";
import type { WorktreePackage } from "../lib/types.ts";

export function CommandPalette({
  packages,
  busyKey,
  onRun,
}: {
  packages: WorktreePackage[];
  busyKey: string | null;
  onRun: (c: FlatCommand) => void;
}) {
  const all = useMemo(() => flattenCommands(packages), [packages]);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the search input when the palette mounts. The dialog opens before the
  // scripts finish loading, so this component mounts after the dialog's initial
  // autofocus — we re-focus here so the user can type immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Our own fzf-style scoring, so cmdk's built-in filter is disabled and fed the
  // already-ranked results; cmdk still owns keyboard nav and selection.
  const results = useMemo(() => fuzzyFilter(query, all, (c) => c.searchText), [query, all]);

  // Group ranked results by package, preserving encounter order so the
  // best-matching packages stay near the top. The package name lives in the
  // group heading instead of repeating on every row.
  const groups = useMemo(() => {
    const m = new Map<string, FlatCommand[]>();
    for (const c of results.slice(0, 200)) {
      const list = m.get(c.pkg) ?? [];
      list.push(c);
      m.set(c.pkg, list);
    }
    return [...m.entries()];
  }, [results]);

  return (
    <Command shouldFilter={false}>
      <CommandInput
        ref={inputRef}
        value={query}
        onValueChange={setQuery}
        placeholder="Run a command…"
      />
      <CommandList className="max-h-[40vh]">
        <CommandEmpty>No matching scripts.</CommandEmpty>
        {groups.map(([pkg, cmds]) => (
          <CommandGroup key={pkg} heading={pkg}>
            {cmds.map((c) => {
              const key = `${c.dir}:${c.script}`;
              return (
                <CommandItem
                  key={key}
                  value={key}
                  disabled={busyKey === key}
                  onSelect={() => onRun(c)}
                  className="gap-3"
                >
                  <span className="w-44 shrink-0 truncate font-mono text-xs text-foreground" title={c.script}>{c.script}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/70" title={c.cmd}>{c.cmd}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
      {results.length > 200 && (
        <p className="px-3 pb-2 text-[11px] text-muted-foreground/70">
          showing 200 of {results.length} — keep typing to narrow
        </p>
      )}
    </Command>
  );
}
