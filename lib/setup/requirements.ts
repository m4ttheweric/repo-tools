/**
 * Pack requirements reader — discovers and parses each pack's
 * requirements.jsonc under a joined team's local clone
 * (~/.mattstack/teams/<slug>/**\/requirements.jsonc, e.g.
 * teams/<slug>/mattstack/packs/<pack>/requirements.jsonc), so `rt setup` can
 * fold pack-declared tools/integrations into the plan without any pack
 * hardcoding its own path here.
 */

import { basename, dirname, join } from "path";
import type { Integration } from "./contract.ts";
import { INTEGRATIONS } from "./integrations.ts";
import { stripJsonc } from "../jsonc.ts";
import type { Probes } from "./probes.ts";

export interface ToolRequirement {
  name: string;
  floor?: string;
  why: string;
  install?: { brew?: string; url?: string };
  connect?: { integration: Integration } | { verb: string[]; label: string };
  optional?: boolean;
}

export interface PackRequirements {
  pack: string;
  tools: ToolRequirement[];
  integrations: Integration[];
  chrome?: { required: boolean; signedIntoApp?: string };
  workType?: string;
  error?: string;
}

const REQUIREMENTS_FILE = "requirements.jsonc";
/** teams/<slug>/mattstack/packs/<pack>/requirements.jsonc is 4 path segments deep from the team root. */
const MAX_DEPTH = 4;
/** Never worth descending into on a real team clone — .git alone would cost a readdir per loose-object shard at every depth. */
const SKIP_DIRS = new Set([".git", "node_modules"]);

const KNOWN_INTEGRATION_IDS = new Set<Integration>(Object.keys(INTEGRATIONS) as Integration[]);

function findRequirementsFiles(p: Pick<Probes, "readDir">, dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) return;
  for (const entry of p.readDir(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (entry === REQUIREMENTS_FILE) out.push(full);
    else findRequirementsFiles(p, full, depth + 1, out);
  }
}

/** [] when the team has no packs with a requirements.jsonc; a file that fails to read yields one error entry rather than being silently skipped. Sorted and deduped by pack name — discovery order is filesystem-dependent, and two directories sharing a pack name must still yield one entry. */
export function readPackRequirements(p: Pick<Probes, "readDir" | "readFile" | "exists" | "home">, teamSlug: string): PackRequirements[] {
  const root = join(p.home, ".mattstack", "teams", teamSlug);
  const files: string[] = [];
  findRequirementsFiles(p, root, 1, files);

  const results = files.map((file) => {
    const packName = basename(dirname(file));
    const text = p.readFile(file);
    if (text === null) return { pack: packName, tools: [], integrations: [], error: `could not read ${file}` };
    return parseRequirements(packName, text);
  });

  const seen = new Set<string>();
  const deduped: PackRequirements[] = [];
  for (const r of results) {
    if (seen.has(r.pack)) continue;
    seen.add(r.pack);
    deduped.push(r);
  }
  return deduped.sort((a, b) => a.pack.localeCompare(b.pack));
}

/** Malformed entries and a dropped connect.integration are both reported through `error`, never silently — `index`/`packName` name which tool a pack author needs to fix, since two skipped entries in one file would otherwise render as identical, unactionable text. */
function parseToolRequirement(t: unknown, index: number, packName: string): { tool: ToolRequirement | null; error?: string } {
  if (typeof t !== "object" || t === null) return { tool: null, error: `pack "${packName}": tools[${index}] is malformed, skipped` };
  const o = t as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.why !== "string") {
    return { tool: null, error: `pack "${packName}": tools[${index}] is malformed, skipped` };
  }

  const result: ToolRequirement = { name: o.name, why: o.why };
  if (typeof o.floor === "string") result.floor = o.floor;
  if (typeof o.optional === "boolean") result.optional = o.optional;

  if (typeof o.install === "object" && o.install !== null) {
    const i = o.install as Record<string, unknown>;
    const install: { brew?: string; url?: string } = {};
    if (typeof i.brew === "string") install.brew = i.brew;
    if (typeof i.url === "string") install.url = i.url;
    result.install = install;
  }

  let connectError: string | undefined;
  if (typeof o.connect === "object" && o.connect !== null) {
    const c = o.connect as Record<string, unknown>;
    if (typeof c.integration === "string") {
      if (KNOWN_INTEGRATION_IDS.has(c.integration as Integration)) {
        result.connect = { integration: c.integration as Integration };
      } else {
        connectError = `pack "${packName}": tool "${result.name}" declares unknown integration "${c.integration}"`;
      }
    } else if (Array.isArray(c.verb) && c.verb.every((v) => typeof v === "string") && typeof c.label === "string") {
      result.connect = { verb: c.verb as string[], label: c.label };
    }
  }

  return { tool: result, error: connectError };
}

/** stripJsonc + shape validation. Unknown integration ids and malformed tool entries are dropped, not fatal — the pack still yields whatever parsed, plus `error` naming what was dropped. Totally unparsable JSON or a non-object root yields empty tools/integrations with `error` set. */
export function parseRequirements(packName: string, text: string): PackRequirements {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonc(text));
  } catch (e) {
    return { pack: packName, tools: [], integrations: [], error: `invalid JSON: ${(e as Error).message}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { pack: packName, tools: [], integrations: [], error: "requirements.jsonc must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  const tools: ToolRequirement[] = [];
  if (Array.isArray(obj.tools)) {
    obj.tools.forEach((t, index) => {
      const { tool, error } = parseToolRequirement(t, index, packName);
      if (tool) tools.push(tool);
      if (error) errors.push(error);
    });
  }

  const integrations: Integration[] = [];
  if (Array.isArray(obj.integrations)) {
    for (const id of obj.integrations) {
      if (typeof id === "string" && KNOWN_INTEGRATION_IDS.has(id as Integration)) integrations.push(id as Integration);
      else errors.push(`unknown integration "${String(id)}"`);
    }
  }

  const result: PackRequirements = { pack: packName, tools, integrations };

  if (typeof obj.chrome === "object" && obj.chrome !== null) {
    const c = obj.chrome as Record<string, unknown>;
    if (typeof c.required === "boolean") {
      result.chrome = { required: c.required, ...(typeof c.signedIntoApp === "string" ? { signedIntoApp: c.signedIntoApp } : {}) };
    }
  }
  if (typeof obj.workType === "string") result.workType = obj.workType;
  if (errors.length > 0) result.error = errors.join("; ");

  return result;
}
