/**
 * Headless React hooks over the settings-kit server routes. State and
 * actions only — the caller renders. React is a peer dependency and the
 * only one; data flows over plain fetch so any host client can use these
 * regardless of its data layer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EffectiveWire, ExplainRowWire, SettingDefWire } from "./server.ts";

export type { EffectiveWire, ExplainRowWire, SettingDefWire };

export interface SettingsKitOptions {
  /** Where the host mounted settingsHandler. Default "/api/settings". */
  basePath?: string;
}

export interface SettingsScopeState {
  defs: SettingDefWire[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** Write one key and patch its def's `effective` in place. Resolves null
      on success, else the server's refusal message verbatim. */
  set: (key: string, scope: string, value: unknown) => Promise<string | null>;
  /** The key currently being written, else null. */
  saving: string | null;
}

export interface SettingKeyState {
  def: SettingDefWire | null;
  rows: ExplainRowWire[];
  loading: boolean;
  error: string | null;
  /** The value staged for the next apply, or undefined when nothing staged. */
  staged: { scope: string; value: unknown } | undefined;
  stage: (scope: string, value: unknown) => void;
  reset: () => void;
  apply: (team?: string) => Promise<boolean>;
  applying: boolean;
  applyError: string | null;
  refresh: () => void;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `settings request failed: ${res.status}`);
  if (body === null) throw new Error("settings response was not JSON");
  return body;
}

/** Every registered def whose key starts with `prefix` ("" = all). */
export function useSettingsScope(prefix: string, opts: SettingsKitOptions = {}): SettingsScopeState {
  const base = opts.basePath ?? "/api/settings";
  const [defs, setDefs] = useState<SettingDefWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getJson<{ defs: SettingDefWire[] }>(`${base}/defs?prefix=${encodeURIComponent(prefix)}`)
      .then((body) => {
        if (!alive) return;
        setDefs(body.defs);
        setError(null);
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [base, prefix, generation]);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);

  const [saving, setSaving] = useState<string | null>(null);
  const set = useCallback(
    async (key: string, scope: string, value: unknown): Promise<string | null> => {
      setSaving(key);
      try {
        const res = await fetch(`${base}/set`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key, scope, value }),
        });
        const body = (await res.json().catch(() => null)) as
          | { effective?: EffectiveWire; error?: string }
          | null;
        if (!res.ok || !body?.effective) return body?.error ?? `save failed: ${res.status}`;
        const effective = body.effective;
        setDefs((prev) => prev.map((d) => (d.key === key ? { ...d, effective } : d)));
        return null;
      } catch (err) {
        return (err as Error).message;
      } finally {
        setSaving(null);
      }
    },
    [base],
  );

  return useMemo(
    () => ({ defs, loading, error, refresh, set, saving }),
    [defs, loading, error, refresh, set, saving],
  );
}

/** One key's layer stack plus the stage → apply state machine. */
export function useSettingKey(key: string, opts: SettingsKitOptions = {}): SettingKeyState {
  const base = opts.basePath ?? "/api/settings";
  const [def, setDef] = useState<SettingDefWire | null>(null);
  const [rows, setRows] = useState<ExplainRowWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<{ scope: string; value: unknown } | undefined>(undefined);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  // Guards a slow apply resolving after the caller switched keys — its
  // rows/errors must not land on the new key's state.
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setStaged(undefined);
    setApplyError(null);
    getJson<{ def: SettingDefWire; rows: ExplainRowWire[] }>(
      `${base}/explain/${encodeURIComponent(key)}`,
    )
      .then((body) => {
        if (!alive) return;
        setDef(body.def);
        setRows(body.rows);
        setError(null);
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [base, key, generation]);

  const stage = useCallback((scope: string, value: unknown) => {
    setStaged({ scope, value });
    setApplyError(null);
  }, []);

  const reset = useCallback(() => {
    setStaged(undefined);
    setApplyError(null);
  }, []);

  const apply = useCallback(
    async (team?: string): Promise<boolean> => {
      if (!staged) return false;
      const appliedKey = keyRef.current;
      setApplying(true);
      setApplyError(null);
      try {
        const res = await fetch(`${base}/set`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: appliedKey, scope: staged.scope, value: staged.value, team }),
        });
        const body = (await res.json().catch(() => null)) as
          | { rows?: ExplainRowWire[]; error?: string }
          | null;
        if (!res.ok || !body?.rows) {
          if (keyRef.current === appliedKey) setApplyError(body?.error ?? `apply failed: ${res.status}`);
          return false;
        }
        if (keyRef.current === appliedKey) {
          setRows(body.rows);
          setStaged(undefined);
        }
        return true;
      } catch (err) {
        if (keyRef.current === appliedKey) setApplyError((err as Error).message);
        return false;
      } finally {
        if (keyRef.current === appliedKey) setApplying(false);
      }
    },
    [base, staged],
  );

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);

  return useMemo(
    () => ({ def, rows, loading, error, staged, stage, reset, apply, applying, applyError, refresh }),
    [def, rows, loading, error, staged, stage, reset, apply, applying, applyError, refresh],
  );
}
