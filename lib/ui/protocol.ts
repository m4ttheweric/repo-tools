/**
 * Wire types for the rt-ui bridge. One JSON object per line, UTF-8. The
 * same shapes are golden-tested from Go against ui/fixtures/*.json; a
 * change here without a fixture change is a contract break.
 */

export const PROTOCOL_VERSION = 1 as const;

export interface PromptOption {
  value: string;
  label: string;
  hint?: string;
}

interface PromptBase {
  t: "prompt";
  protocol: typeof PROTOCOL_VERSION;
  /** Domain text only: a description, or the validation message a re-prompt carries. Go composes the keybind header itself. */
  hint?: string;
}

export interface SelectSpec extends PromptBase {
  kind: "select";
  title: string;
  options: PromptOption[];
  initial?: string;
  back?: { label: string };
}

export interface MultiselectSpec extends PromptBase {
  kind: "multiselect";
  title: string;
  options: PromptOption[];
  initial?: string[];
  min?: number;
  max?: number;
}

export interface ConfirmSpec extends PromptBase {
  kind: "confirm";
  message: string;
  default?: boolean;
  destructive?: boolean;
}

export interface TextSpec extends PromptBase {
  kind: "text";
  title: string;
  placeholder?: string;
  initial?: string;
  validate?: { pattern: string; message: string };
}

export type PromptSpec = SelectSpec | MultiselectSpec | ConfirmSpec | TextSpec;

export type PromptResult =
  | { t: "result"; value: string }
  | { t: "result"; values: string[] }
  | { t: "result"; ok: boolean }
  | { t: "result"; text: string };

export type StepLevel = "info" | "warn" | "error" | "success";

export type StepEvent =
  | { t: "hello"; protocol: typeof PROTOCOL_VERSION }
  | { t: "start"; title: string }
  | { t: "log"; level: StepLevel; text: string }
  | { t: "done"; title: string; hint?: string }
  | { t: "fail"; title: string; hint?: string };

export function encodeLine(msg: object): string {
  return JSON.stringify(msg) + "\n";
}

export function parsePromptResult(line: string): PromptResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.trim());
  } catch {
    throw new Error(`rt-ui result: not JSON: ${line.slice(0, 120)}`);
  }
  const r = parsed as Record<string, unknown>;
  if (r?.t !== "result") throw new Error(`rt-ui result: unexpected message ${line.slice(0, 120)}`);
  if (typeof r.value === "string") return { t: "result", value: r.value };
  if (Array.isArray(r.values)) return { t: "result", values: r.values.map(String) };
  if (typeof r.ok === "boolean") return { t: "result", ok: r.ok };
  if (typeof r.text === "string") return { t: "result", text: r.text };
  throw new Error(`rt-ui result: no value/values/ok/text in ${line.slice(0, 120)}`);
}

// ─── session ─────────────────────────────────────────────────────────────────

export type BoardState = "running" | "stopped" | "crashed" | "starting" | "stopping";

export interface BoardTailLine {
  ts: string;
  text: string;
}

export interface BoardEntry {
  id: string;
  name: string;
  command: string;
  pkg: string;
  repo: string;
  state: BoardState;
  startedAt: string | null;
  exitCode: number | null;
  error: string | null;
  tail: BoardTailLine[] | null;
}

export interface BoardModel {
  workspace: string;
  entries: BoardEntry[];
}

export interface SessionHello {
  t: "hello";
  protocol: number;
  version: string;
  views: string[];
}

export interface SessionIntent {
  t: "intent";
  name: "add" | "restart" | "stop" | "focus" | "tail" | "quit";
  entryId?: string;
  open?: boolean;
}

export interface SessionClosed {
  t: "closed";
  reason: "quit" | "cancel" | "closed" | "error";
  message?: string;
}

export type SessionInbound = SessionHello | SessionIntent | SessionClosed;

export function parseSessionLine(line: string): SessionInbound {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.trim());
  } catch {
    throw new Error(`rt-ui session: not JSON: ${line.slice(0, 120)}`);
  }
  const m = parsed as Record<string, unknown>;
  switch (m?.t) {
    case "hello":
      if (typeof m.protocol !== "number" || !Array.isArray(m.views)) break;
      return { t: "hello", protocol: m.protocol, version: String(m.version ?? ""), views: m.views.map(String) };
    case "intent":
      if (typeof m.name !== "string") break;
      return {
        t: "intent",
        name: m.name as SessionIntent["name"],
        ...(typeof m.entryId === "string" ? { entryId: m.entryId } : {}),
        ...(typeof m.open === "boolean" ? { open: m.open } : {}),
      };
    case "closed":
      if (typeof m.reason !== "string") break;
      return { t: "closed", reason: m.reason as SessionClosed["reason"], ...(typeof m.message === "string" ? { message: m.message } : {}) };
  }
  throw new Error(`rt-ui session: unexpected message ${line.slice(0, 120)}`);
}
