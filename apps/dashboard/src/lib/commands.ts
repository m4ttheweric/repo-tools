import type { WorktreePackage } from "./types.ts";

/** One runnable command, flattened from packages → scripts, for the palette. */
export interface FlatCommand {
  pkg: string;
  dir: string;
  script: string;
  cmd: string;
  searchText: string;
}

export function flattenCommands(packages: WorktreePackage[]): FlatCommand[] {
  return packages.flatMap((p) =>
    p.scripts.map((s) => ({
      pkg: p.name,
      dir: p.dir,
      script: s.name,
      cmd: s.cmd,
      searchText: `${p.name} ${s.name}`,
    })),
  );
}
