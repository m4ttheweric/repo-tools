/**
 * Herdr attach bridge — spawns `herdr terminal attach <terminalId>` under a
 * fresh PTY and forwards its output to a WebSocket client. Used by the API
 * server's /ws/processes/:id/{logs,attach} endpoints when the herdr backend
 * is active.
 */

import type { PaneMap } from "./pane-map.ts";

export interface HerdrAttachBridge {
  term: any;
  proc: ReturnType<typeof Bun.spawn>;
}

export function spawnHerdrAttach(opts: {
  id: string;
  paneMap: PaneMap;
  userPath: string | undefined;
  send: (chunk: Uint8Array) => void;
}): HerdrAttachBridge {
  const { id, paneMap, send } = opts;
  const ref = paneMap.get(id);
  // rt-launched panes resolve their terminalId via the map; panes created
  // directly in herdr surface from describe() with their terminalId AS the
  // record id, so fall back to the id itself.
  const terminalId = ref?.terminalId ?? id;
  const userPath = opts.userPath ?? process.env.PATH ?? "";
  const herdrBin = userPath
    .split(":")
    .map((d: string) => `${d}/herdr`)
    .find((p: string) => { try { return Bun.file(p).size > 0; } catch { return false; } })
    ?? `${process.env.HOME}/.local/bin/herdr`;
  const herdrEnv = { ...process.env, PATH: userPath } as Record<string, string>;
  const term = new Bun.Terminal({
    data(_t: any, chunk: Uint8Array) {
      send(chunk);
    },
  });
  const proc = Bun.spawn([herdrBin, "terminal", "attach", terminalId], {
    terminal: term,
    ...(ref?.cwd ? { cwd: ref.cwd } : {}),
    env: herdrEnv,
  });
  return { term, proc };
}
