/**
 * Framework-neutral settings routes over @mattstack/rt-client.
 *
 * Hosts call `settingsHandler(req)` early in their fetch handler; `null`
 * means "not a settings route, fall through". Works identically under a
 * hand-rolled `Bun.serve` switch and a Hono `app.all` catch-all, so one
 * implementation serves every mattstack app.
 *
 * Settings run through rt-client IN PROCESS — no daemon, no spawned rt.
 * `setSetting` throws its refusals as `rt: …` errors; those are "rt said no"
 * conditions the client should read, so they answer 400 here rather than
 * bubbling as a host 500.
 */

import {
  allDefs,
  explainSetting,
  getDef,
  isMigrated,
  setSetting,
  unsetSetting,
  validateValue,
  type ExplainRow,
  type SettingDef,
  type SettingScope,
} from "@mattstack/rt-client";

export interface SettingDefWire {
  key: string;
  type: SettingDef["type"];
  scopes: SettingDef["scopes"];
  merge: SettingDef["merge"];
  secret: boolean;
  teamLocked: boolean;
  repoScoped: boolean;
  /** Computed once, server-side: migrated AND not secret AND not composite.
      Every client edit affordance keys off this instead of re-deriving it. */
  writable: boolean;
  description: string;
  hasDefault: boolean;
  defaultValue: unknown;
  effective: EffectiveWire;
}

export type ExplainRowWire = Pick<
  ExplainRow,
  "scope" | "file" | "present" | "shadowed" | "invalid"
> & { value?: unknown };

/** The winning layer, precomputed server-side so a list view renders and
    patches rows without a per-key explain round trip. `scope` is the winning
    layer's scope, "default" when the registry default wins, null when
    nothing is set and there is no default. `value` is omitted for secrets
    and when scope is null. */
export interface EffectiveWire {
  scope: string | null;
  value?: unknown;
  file: string | null;
  invalid?: string;
}

/** The slice of rt-client the handler consumes — injectable so tests fake it
    without `mock.module`, which mutates the shared module registry and
    poisons every later test importing rt-client in the same process. */
export interface RtSettingsApi {
  allDefs: typeof allDefs;
  getDef: typeof getDef;
  isMigrated: typeof isMigrated;
  explainSetting: typeof explainSetting;
  validateValue: typeof validateValue;
  setSetting: typeof setSetting;
  unsetSetting: typeof unsetSetting;
}

export interface SettingsHandlerOptions {
  /** Route prefix the handler answers under. Default "/api/settings". */
  basePath?: string;
  /** Admit composite (object/array) keys to the write path. Off by default:
      comment-preserving jsonc edits of nested values are the risk the guard
      exists for — a host opting in accepts JSON-shaped replacement of the
      whole value. */
  allowComposite?: boolean;
  /** Override the rt-client functions (tests, instrumentation). */
  rt?: Partial<RtSettingsApi>;
  /**
   * Write gate. The default admits only requests whose Host is loopback or a
   * deck-local TLD (localhost, 127.0.0.1, [::1], *.localhost, *.mattstack) —
   * a Host-header check, because a standard `Request` carries no peer
   * address. A host app that knows the real peer (e.g. Bun's
   * `server.requestIP`) should pass its own stricter predicate; an app with
   * any non-local exposure (relay, peer sync) MUST.
   */
  allowWrite?: (req: Request) => boolean;
}

const COMPOSITE_COPY = "composite value — edit the file";

function isComposite(def: SettingDef): boolean {
  return def.type === "object" || def.type === "array";
}

function isWritable(def: SettingDef, migrated: (def: SettingDef) => boolean = isMigrated, composites = false): boolean {
  return migrated(def) && def.secret !== true && (composites || !isComposite(def));
}

export function defToWire(def: SettingDef, migrated: ((def: SettingDef) => boolean) | undefined, effective: EffectiveWire, composites = false): SettingDefWire {
  return {
    key: def.key,
    type: def.type,
    scopes: def.scopes,
    merge: def.merge,
    secret: def.secret === true,
    teamLocked: def.teamLocked === true,
    repoScoped: def.repoScoped === true,
    writable: isWritable(def, migrated, composites),
    description: def.description,
    hasDefault: "default" in def,
    defaultValue: def.default ?? null,
    effective,
  };
}

/**
 * Secret values must never reach the wire — presence and file only. This is
 * the ONLY place explain rows are serialized, so stripping here is the whole
 * guarantee; a second serialization path would reopen the leak.
 */
export function sanitizeRows(def: SettingDef, rows: ExplainRow[]): ExplainRowWire[] {
  return rows.map((row) => {
    const wire: ExplainRowWire = {
      scope: row.scope,
      file: row.file,
      present: row.present,
    };
    if (row.shadowed) wire.shadowed = row.shadowed;
    if (row.invalid) wire.invalid = row.invalid;
    if (def.secret !== true && "value" in row) wire.value = row.value;
    return wire;
  });
}


/** Winning layer from the explain rows (first present, un-shadowed, valid row
    in resolution order), else the registry default, else null. Secrets omit
    the value — same rule as sanitizeRows. */
export function effectiveFromRows(def: SettingDef, rows: ExplainRow[]): EffectiveWire {
  for (const row of rows) {
    if (!row.present || row.shadowed) continue;
    if (row.invalid) return { scope: row.scope, file: row.file, invalid: row.invalid };
    const wire: EffectiveWire = { scope: row.scope, file: row.file };
    if (def.secret !== true && "value" in row) wire.value = row.value;
    return wire;
  }
  if ("default" in def) {
    const wire: EffectiveWire = { scope: "default", file: null };
    if (def.secret !== true) wire.value = def.default;
    return wire;
  }
  return { scope: null, file: null };
}

function defaultAllowWrite(req: Request): boolean {
  let host: string;
  try {
    host = new URL(req.url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost") ||
    host.endsWith(".mattstack")
  );
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * Answers:
 *   GET  {base}/defs[?prefix=board.]  → { defs: SettingDefWire[] }
 *   GET  {base}/explain/{key}         → { def, rows }
 *   POST {base}/set                   → { rows, effective } | { error }
 *   POST {base}/unset                 → { rows, effective } | { error }
 * Returns null for anything else so the host's routing continues.
 */
export async function settingsHandler(
  req: Request,
  opts: SettingsHandlerOptions = {},
): Promise<Response | null> {
  const base = (opts.basePath ?? "/api/settings").replace(/\/+$/, "");
  const rt: RtSettingsApi = { allDefs, getDef, isMigrated, explainSetting, validateValue, setSetting, unsetSetting, ...opts.rt };
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return null;
  }
  const path = url.pathname;
  if (path !== `${base}/defs` && !path.startsWith(`${base}/explain/`) && path !== `${base}/set` && path !== `${base}/unset`) {
    return null;
  }

  if (path === `${base}/defs` && req.method === "GET") {
    const prefix = url.searchParams.get("prefix") ?? "";
    const defs = rt.allDefs()
      .filter((d) => d.key.startsWith(prefix))
      .map((d) => defToWire(d, rt.isMigrated, effectiveFromRows(d, rt.explainSetting(d.key)), opts.allowComposite === true));
    return json({ defs });
  }

  if (path.startsWith(`${base}/explain/`) && req.method === "GET") {
    const key = decodeURIComponent(path.slice(`${base}/explain/`.length));
    const def = rt.getDef(key);
    if (!def) return json({ error: `unknown setting "${key}"` }, 404);
    const rows = rt.explainSetting(key);
    return json({
      def: defToWire(def, rt.isMigrated, effectiveFromRows(def, rows), opts.allowComposite === true),
      rows: sanitizeRows(def, rows),
    });
  }

  if (path === `${base}/set` && req.method === "POST") {
    const allow = opts.allowWrite ?? defaultAllowWrite;
    if (!allow(req)) return json({ error: "settings writes are local-only" }, 403);

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }
    const key = typeof body?.key === "string" ? body.key : "";
    const scope = (typeof body?.scope === "string" ? body.scope : "") as SettingScope;
    const team = typeof body?.team === "string" ? body.team : undefined;
    const value = body?.value;

    const def = rt.getDef(key);
    if (!def) return json({ error: `unknown setting "${key}"` }, 404);
    if (def.secret === true) return json({ error: "secret keys are not writable here" }, 400);
    if (isComposite(def) && opts.allowComposite !== true) return json({ error: COMPOSITE_COPY }, 400);
    if (!def.scopes.includes(scope)) {
      return json(
        { error: `"${key}" cannot be set in the ${scope} store (allowed: ${def.scopes.join(", ")})` },
        400,
      );
    }
    if (!isWritable(def, rt.isMigrated, opts.allowComposite === true)) {
      return json({ error: `"${key}" is not writable through the resolver yet` }, 400);
    }
    const check = rt.validateValue(def, value);
    if (!check.ok) return json({ error: check.reason }, 400);

    try {
      rt.setSetting(key, value, scope, team ? { team } : {});
    } catch (err) {
      return json({ error: (err as Error).message }, 400);
    }
    const after = rt.explainSetting(key);
    return json({ rows: sanitizeRows(def, after), effective: effectiveFromRows(def, after) });
  }

  if (path === `${base}/unset` && req.method === "POST") {
    const allow = opts.allowWrite ?? defaultAllowWrite;
    if (!allow(req)) return json({ error: "settings writes are local-only" }, 403);

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }
    const key = typeof body?.key === "string" ? body.key : "";
    const scope = (typeof body?.scope === "string" ? body.scope : "") as SettingScope;
    const team = typeof body?.team === "string" ? body.team : undefined;

    // Same ladder as set, minus the value check — removal has no value. The
    // writable/composite gates stay: a row the UI renders read-only must not
    // be clearable through the API either.
    const def = rt.getDef(key);
    if (!def) return json({ error: `unknown setting "${key}"` }, 404);
    if (def.secret === true) return json({ error: "secret keys are not writable here" }, 400);
    if (isComposite(def) && opts.allowComposite !== true) return json({ error: COMPOSITE_COPY }, 400);
    if (!def.scopes.includes(scope)) {
      return json(
        { error: `"${key}" cannot be unset in the ${scope} store (allowed: ${def.scopes.join(", ")})` },
        400,
      );
    }
    if (!isWritable(def, rt.isMigrated, opts.allowComposite === true)) {
      return json({ error: `"${key}" is not writable through the resolver yet` }, 400);
    }

    try {
      rt.unsetSetting(key, scope, team ? { team } : {});
    } catch (err) {
      return json({ error: (err as Error).message }, 400);
    }
    const after = rt.explainSetting(key);
    return json({ rows: sanitizeRows(def, after), effective: effectiveFromRows(def, after) });
  }

  return json({ error: "method not allowed" }, 405);
}
