/**
 * rt sdm connector protocol v1.
 *
 * A connector is any executable in ~/.rt/sdm/connectors/. rt runs
 * `<file> discover` and reads one ConnectorOutput JSON document from stdout.
 * Validation is hand-rolled (no schema dependency) with error strings that
 * pinpoint the offending connection and field.
 */

export interface ConnectorConnection {
  id: string;
  label: string;
  sdmResource: string;
  tier?: string;
  production?: boolean;
  reasonSuggestion?: string;
  db?: { database?: string; schema?: string; user?: string };
  meta?: Record<string, string>;
}

export interface ConnectorOutput {
  version: 1;
  connections: ConnectorConnection[];
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
  return { ok: true, output: raw as unknown as ConnectorOutput };
}
