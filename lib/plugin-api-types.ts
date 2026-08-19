/**
 * Public plugin API contract. This single file is BOTH:
 *  - the types rt's implementation is checked against (imported as types), and
 *  - the literal text written to ~/.mattstack/rt/plugin-api/index.d.ts for plugin
 *    authors (imported with { type: "text" } and embedded in the binary).
 * Drift is impossible by construction, so it must contain ONLY type-level
 * declarations (interfaces and type aliases; no values, no imports).
 */

/** Repo/worktree identity resolved by the dispatcher (mirrors lib/repo.ts RepoIdentity). */
export interface RtIdentity {
  repoName: string;
  repoRoot: string;
  dataDir: string;
  remoteUrl: string;
  baseUrl: string;
}

export type RtPickItem = string | { value: string; label?: string; hint?: string };

export interface RtStore<T> {
  get(): Promise<T | null>;
  set(value: T): Promise<void>;
}

export interface RtLogger {
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  /** Only written when RT_LOG_LEVEL=debug. */
  debug(msg: string, data?: object): void;
}

export interface RtApi {
  /** Fuzzy picker (rt's standard palette). Resolves null on cancel/Esc. */
  pick(items: RtPickItem[], opts?: { label?: string }): Promise<string | null>;
  /** Single-line text input. */
  prompt(label: string, opts?: { placeholder?: string; default?: string }): Promise<string | null>;
  confirm(label: string, opts?: { default?: boolean }): Promise<boolean>;
  /** Scoped JSON storage at ~/.mattstack/rt/plugin-data/<plugin>/<key>.json. */
  store<T>(key: string): RtStore<T>;
  /** Domain events, written to ~/.mattstack/rt/logs/plugins.YYYY-MM-DD.log as JSON lines. */
  log: RtLogger;
}

/** Second argument to every plugin command function. */
export interface RtCommandContext {
  /** Present when the manifest node declares "context": "repo" | "worktree". */
  identity?: RtIdentity;
  /** True when identity was auto-detected from cwd (not user-picked). */
  autoResolved?: boolean;
  rt: RtApi;
}
