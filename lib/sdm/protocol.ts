/**
 * rt sdm connector protocol v1.
 *
 * A connector is any executable in ~/.rt/sdm/connectors/. rt runs
 * `<file> discover` and reads one ConnectorOutput JSON document from stdout.
 * Validation is hand-rolled (no schema dependency) with error strings that
 * pinpoint the offending connection and field.
 */

export type EnvKey = "dev" | "qa" | "labs" | "staging" | "prod";

export interface Resolution {
  source: "exact" | "override";
  candidates?: string[];
  readOnlyAlt?: string;
}

export interface UnresolvedEntry {
  id: string;
  label: string;
  slug: string;
  env: EnvKey;
  tier?: string;
  source: "ambiguous" | "none";
  candidates: string[];
  readOnlyAlt?: string;
  note?: string;
  url?: string;
}

export interface ConnectorConnection {
  id: string;
  label: string;
  sdmResource: string;
  tier?: string;
  production?: boolean;
  reasonSuggestion?: string;
  resolution?: Resolution;
  db?: { database?: string; schema?: string; user?: string };
  meta?: Record<string, string>;
}

export interface ConnectorOutput {
  version: 1;
  connections: ConnectorConnection[];
  unresolved?: UnresolvedEntry[];
  allResources?: string[];
}

export type ValidationResult =
  | { ok: true; output: ConnectorOutput }
  | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function optionalStringField(
  obj: Record<string, unknown>, key: string, path: string,
): string | null {
  if (obj[key] !== undefined && typeof obj[key] !== "string") {
    return `${path}.${key}: expected string`;
  }
  return null;
}

export function validateConnectorOutput(raw: unknown): ValidationResult {
  if (!isRecord(raw)) return { ok: false, error: "output: expected a JSON object" };
  if (raw.version !== 1) return { ok: false, error: `version: expected 1, got ${JSON.stringify(raw.version)}` };
  if (!Array.isArray(raw.connections)) return { ok: false, error: "connections: expected an array" };

  for (let i = 0; i < raw.connections.length; i++) {
    const c = raw.connections[i];
    const path = `connections[${i}]`;
    if (!isRecord(c)) return { ok: false, error: `${path}: expected an object` };
    for (const key of ["id", "label", "sdmResource"] as const) {
      if (!nonEmptyString(c[key])) return { ok: false, error: `${path}.${key}: expected non-empty string` };
    }
    for (const key of ["tier", "reasonSuggestion"] as const) {
      const err = optionalStringField(c, key, path);
      if (err) return { ok: false, error: err };
    }
    if (c.production !== undefined && typeof c.production !== "boolean") {
      return { ok: false, error: `${path}.production: expected boolean` };
    }
    if (c.resolution !== undefined) {
      if (!isRecord(c.resolution)) return { ok: false, error: `${path}.resolution: expected an object` };
      const source = c.resolution.source;
      if (typeof source !== "string" || !["exact", "override"].includes(source)) {
        return { ok: false, error: `${path}.resolution.source: expected "exact" or "override"` };
      }
      if (c.resolution.candidates !== undefined) {
        if (!Array.isArray(c.resolution.candidates)) return { ok: false, error: `${path}.resolution.candidates: expected an array` };
        for (let j = 0; j < c.resolution.candidates.length; j++) {
          if (typeof c.resolution.candidates[j] !== "string") {
            return { ok: false, error: `${path}.resolution.candidates[${j}]: expected string` };
          }
        }
      }
      const err = optionalStringField(c.resolution, "readOnlyAlt", `${path}.resolution`);
      if (err) return { ok: false, error: err };
    }
    if (c.db !== undefined) {
      if (!isRecord(c.db)) return { ok: false, error: `${path}.db: expected an object` };
      for (const key of ["database", "schema", "user"] as const) {
        const err = optionalStringField(c.db, key, `${path}.db`);
        if (err) return { ok: false, error: err };
      }
    }
    if (c.meta !== undefined) {
      if (!isRecord(c.meta)) return { ok: false, error: `${path}.meta: expected an object` };
      for (const [k, v] of Object.entries(c.meta)) {
        if (typeof v !== "string") return { ok: false, error: `${path}.meta.${k}: expected string` };
      }
    }
  }

  if (raw.unresolved !== undefined) {
    if (!Array.isArray(raw.unresolved)) return { ok: false, error: "unresolved: expected an array" };
    const envKeys = ["dev", "qa", "labs", "staging", "prod"];
    const sourceKeys = ["ambiguous", "none"];
    for (let i = 0; i < raw.unresolved.length; i++) {
      const u = raw.unresolved[i];
      const path = `unresolved[${i}]`;
      if (!isRecord(u)) return { ok: false, error: `${path}: expected an object` };
      for (const key of ["id", "label", "slug"] as const) {
        if (!nonEmptyString(u[key])) return { ok: false, error: `${path}.${key}: expected non-empty string` };
      }
      const env = u.env;
      if (typeof env !== "string" || !envKeys.includes(env)) {
        return { ok: false, error: `${path}.env: expected one of ${envKeys.map((k) => `"${k}"`).join(", ")}` };
      }
      const err = optionalStringField(u, "tier", path);
      if (err) return { ok: false, error: err };
      const source = u.source;
      if (typeof source !== "string" || !sourceKeys.includes(source)) {
        return { ok: false, error: `${path}.source: expected "ambiguous" or "none"` };
      }
      if (!Array.isArray(u.candidates)) return { ok: false, error: `${path}.candidates: expected an array` };
      for (let j = 0; j < u.candidates.length; j++) {
        if (typeof u.candidates[j] !== "string") {
          return { ok: false, error: `${path}.candidates[${j}]: expected string` };
        }
      }
      for (const key of ["readOnlyAlt", "note", "url"] as const) {
        const err = optionalStringField(u, key, path);
        if (err) return { ok: false, error: err };
      }
    }
  }

  if (raw.allResources !== undefined) {
    if (!Array.isArray(raw.allResources)) return { ok: false, error: "allResources: expected an array" };
    for (let i = 0; i < raw.allResources.length; i++) {
      if (!nonEmptyString(raw.allResources[i])) {
        return { ok: false, error: `allResources[${i}]: expected non-empty string` };
      }
    }
  }

  return { ok: true, output: raw as unknown as ConnectorOutput };
}
