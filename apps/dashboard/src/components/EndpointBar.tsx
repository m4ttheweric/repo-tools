import { useCallback, useEffect, useState } from "react";
import { Copy, ChevronsUpDown, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { fetchEndpoints, mapEndpoint, unmapEndpoint, enableBounce, disableBounce } from "../lib/api.ts";
import type { CanonicalEndpoint, EndpointState, ProcessRecord } from "../lib/types.ts";

export function EndpointBar({ repo, processes }: { repo: string; processes: ProcessRecord[] }) {
  const [endpoints, setEndpoints] = useState<CanonicalEndpoint[]>([]);
  const [state, setState] = useState<EndpointState>({ forward: {}, bounceEnabled: [] });

  const reload = useCallback(
    () =>
      fetchEndpoints(repo)
        .then((d) => {
          setEndpoints(d.endpoints);
          setState(d.state);
        })
        .catch(() => {}),
    [repo],
  );

  useEffect(() => {
    reload();
  }, [reload]);

  const forward = endpoints.filter((e) => e.mode === "forward");
  const bounce = endpoints.filter((e) => e.mode === "bounce");
  if (forward.length === 0 && bounce.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {forward.map((e) => {
        const targetId = state.forward[String(e.port)];
        const target = processes.find((p) => p.id === targetId);
        const mappable = processes.filter((p) => p.state === "running" && p.port != null);
        return (
          <div
            key={e.port}
            className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-xs"
          >
            <Badge variant="outline">:{e.port}</Badge>
            <span className="text-muted-foreground">{e.name}</span>
            {target ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-5 gap-1 px-1.5 text-xs"
                aria-label={`Unmap ${target.id}`}
                title={`Unmap ${target.id}`}
                onClick={() =>
                  unmapEndpoint({ repo, port: e.port })
                    .then(reload)
                    .catch((e) => alert(`unmap failed: ${e}`))
                }
              >
                <span className="font-mono text-foreground">{target.id}</span>
                <X className="size-3 text-muted-foreground" />
              </Button>
            ) : (
              <PickProcess
                processes={mappable}
                onPick={(p) =>
                  mapEndpoint({ repo, port: e.port, processId: p.id, upstreamPort: p.port! })
                    .then(reload)
                    .catch((e) => alert(`map failed: ${e}`))
                }
              />
            )}
          </div>
        );
      })}
      {bounce.map((e) => {
        const on = state.bounceEnabled.includes(e.port);
        const snippet = `http://localhost:${e.port}/callback?${e.returnParam ?? "rt_return"}=<app-origin>`;
        return (
          <div
            key={e.port}
            className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-xs"
          >
            <Badge variant="outline">:{e.port}</Badge>
            <span className="text-muted-foreground">{e.name} (bounce)</span>
            <Button
              size="sm"
              variant={on ? "default" : "ghost"}
              className="h-5 px-1.5 text-xs"
              onClick={() =>
                (on
                  ? disableBounce({ repo, port: e.port })
                  : enableBounce({ repo, port: e.port })
                )
                  .then(reload)
                  .catch((err) => alert(`bounce ${on ? "disable" : "enable"} failed: ${err}`))
              }
            >
              {on ? "on" : "off"}
            </Button>
            {on && (
              <>
                <code className="font-mono text-[11px] text-muted-foreground">{snippet}</code>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1 text-xs"
                  aria-label="Copy redirect_uri"
                  title="Copy redirect_uri"
                  onClick={() => navigator.clipboard.writeText(snippet)}
                >
                  <Copy className="size-3" />
                </Button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PickProcess({
  processes,
  onPick,
}: {
  processes: ProcessRecord[];
  onPick: (p: ProcessRecord) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-5 gap-1 px-1.5 text-xs text-muted-foreground"
          aria-label="Map a running process to this endpoint"
          title="Map a running process to this endpoint"
        >
          map process
          <ChevronsUpDown className="size-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="filter processes..." />
          <CommandList>
            <CommandEmpty>No running processes with a port.</CommandEmpty>
            <CommandGroup>
              {processes.map((p) => (
                <CommandItem
                  key={p.id}
                  value={p.id}
                  onSelect={() => {
                    setOpen(false);
                    onPick(p);
                  }}
                >
                  <span className="font-mono">{p.id}</span>
                  <span className="ml-auto text-muted-foreground">:{p.port}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
