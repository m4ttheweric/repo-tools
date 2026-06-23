// apps/dashboard/src/components/SessionTabs.tsx
import { X, Plus } from "lucide-react";
import { statusDotClass, type Session } from "../lib/sessions.ts";

/**
 * Horizontal tab strip — one tab per session (status dot + label + close ✕).
 * The active tab is filled with the terminal's background (bold, bright text) so
 * it reads as selected and merges into the console below; inactive tabs sit flat
 * on the lighter strip with dim text. A trailing ＋ opens the package-command
 * picker. Single row, scrolls horizontally on overflow so it never pushes the
 * terminal off-screen.
 */
export function SessionTabs({
  sessions,
  activeId,
  onSelect,
  onClose,
  onPickCommand,
}: {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onPickCommand: () => void;
}) {
  return (
    <div className="flex items-stretch gap-1 overflow-x-auto px-2 pt-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {sessions.map((s) => {
        const active = s.id === activeId;
        return (
          <div
            key={s.id}
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(s.id)}
            title={s.cmd || s.label}
            className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md px-2.5 py-1 text-xs transition-colors ${
              active
                ? "bg-background font-medium text-foreground"
                : "text-muted-foreground/60 hover:bg-muted/30 hover:text-foreground"
            }`}
          >
            <span className={`size-2 shrink-0 rounded-full ${statusDotClass(s.state)}`} />
            <span className="max-w-[12rem] truncate">{s.label}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(s.id); }}
              aria-label={`Close ${s.label}`}
              title="Close tab"
              className="ml-0.5 rounded p-0.5 text-muted-foreground/50 hover:bg-muted/60 hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
      <button
        onClick={onPickCommand}
        aria-label="Run a package command"
        title="Run a package command"
        className="flex shrink-0 items-center self-end rounded-t-md px-2 py-1 text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground"
      >
        <Plus className="size-3.5" />
      </button>
      {sessions.length === 0 && (
        <span className="self-center px-2 text-[11px] text-muted-foreground/50">no sessions yet</span>
      )}
    </div>
  );
}
