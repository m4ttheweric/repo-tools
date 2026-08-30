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
