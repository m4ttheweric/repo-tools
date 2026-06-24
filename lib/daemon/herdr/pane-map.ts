import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface PaneRef {
  id: string; workspaceId: string; paneId: string; terminalId: string;
  cwd: string; cmd: string; env?: Record<string, string>; port?: number; startedAt: number;
  kind?: "terminal";
}

export class PaneMap {
  private byId = new Map<string, PaneRef>();
  private dataDir: string;
  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? join(homedir(), ".rt");
    this.load();
  }
  private get path(): string { return join(this.dataDir, "herdr-panes.json"); }
  private load(): void {
    try {
      if (existsSync(this.path)) {
        const raw = JSON.parse(readFileSync(this.path, "utf8")) as PaneRef[];
        for (const r of raw) if (r && r.id) this.byId.set(r.id, r);
      }
    } catch { /* start fresh */ }
  }
  private persist(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(this.path, JSON.stringify([...this.byId.values()], null, 2));
    } catch { /* best-effort */ }
  }
  set(ref: PaneRef): void { this.byId.set(ref.id, ref); this.persist(); }
  get(id: string): PaneRef | undefined { return this.byId.get(id); }
  delete(id: string): void { if (this.byId.delete(id)) this.persist(); }
  all(): PaneRef[] { return [...this.byId.values()]; }
  reconcile(livePaneIds: Set<string>): string[] {
    const dropped: string[] = [];
    for (const [id, ref] of this.byId) if (!livePaneIds.has(ref.paneId)) dropped.push(id);
    for (const id of dropped) this.byId.delete(id);
    if (dropped.length) this.persist();
    return dropped;
  }
}
