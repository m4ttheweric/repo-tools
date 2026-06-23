// apps/dashboard/src/components/SessionTabs.tsx
import { statusDotClass, type Session } from "../lib/sessions.ts";

/**
 * Horizontal tab strip — one tab per session (status dot + label). Single row,
 * scrolls horizontally on overflow so it never pushes the terminal off-screen.
 * The dots double as the at-a-glance running/stopped overview when collapsed.
 */
export function SessionTabs({
  sessions,
  activeId,
  onSelect,
}: {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex gap-1 overflow-x-auto px-2 pt-2 [scrollbar-width:none]">
      {sessions.map((s) => {
        const active = s.id === activeId;
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            title={s.cmd || s.label}
            className={`flex shrink-0 items-center gap-1.5 rounded-t-md px-2.5 py-1 text-xs ${
              active ? "bg-card text-foreground" : "bg-muted/50 text-muted-foreground hover:bg-muted"
            }`}
          >
            <span className={`size-2 rounded-full ${statusDotClass(s.state)}`} />
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
