import { Badge } from "@/components/ui/badge";
import type { ProcessState } from "../lib/types.ts";

// Status colors come from the Selenized accent palette; the chrome is a neutral
// shadcn outline Badge so it reads as a label, with a colored dot for the state.
const DOT: Record<ProcessState, string> = {
  running:  "bg-sel-green",
  warm:     "bg-sel-cyan",
  starting: "bg-sel-yellow",
  stopping: "bg-sel-yellow",
  crashed:  "bg-sel-red",
  stopped:  "bg-muted-foreground",
};

export function StatusBadge({ state }: { state: ProcessState }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-medium capitalize">
      <span className={`size-2 rounded-full ${DOT[state]}`} />
      {state}
    </Badge>
  );
}
