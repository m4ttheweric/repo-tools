/**
 * The prompt facade every command calls. Signatures are frozen; only the
 * renderer changed (Ink to rt-ui). `stderr` is accepted for source
 * compatibility and ignored: /dev/tty rendering keeps stdout clean by itself.
 */
import type { SelectOption } from "../fzf-select.ts";
import { PROTOCOL_VERSION, type PromptOption } from "./protocol.ts";
import { runPrompt } from "./spawn.ts";

function wireOptions(options: SelectOption[]): PromptOption[] {
  return options.map((o) => (o.hint ? { value: o.value, label: o.label, hint: o.hint } : { value: o.value, label: o.label }));
}

export async function select(opts: {
  message: string;
  options: SelectOption[];
  stderr?: boolean;
  backLabel?: string;
}): Promise<string> {
  const r = await runPrompt({
    t: "prompt",
    protocol: PROTOCOL_VERSION,
    kind: "select",
    title: opts.message,
    options: wireOptions(opts.options),
    ...(opts.backLabel ? { back: { label: opts.backLabel } } : {}),
  });
  if (!("value" in r)) throw new Error("rt-ui select: result had no value");
  return r.value;
}

export async function multiselect(opts: {
  message: string;
  options: SelectOption[];
  initialValues?: string[];
  required?: boolean;
  stderr?: boolean;
}): Promise<string[]> {
  const r = await runPrompt({
    t: "prompt",
    protocol: PROTOCOL_VERSION,
    kind: "multiselect",
    title: opts.message,
    options: wireOptions(opts.options),
    ...(opts.initialValues ? { initial: opts.initialValues } : {}),
    ...(opts.required ? { min: 1 } : {}),
  });
  if (!("values" in r)) throw new Error("rt-ui multiselect: result had no values");
  return r.values;
}

export async function confirm(opts: {
  message: string;
  initialValue?: boolean;
  stderr?: boolean;
  destructive?: boolean;
}): Promise<boolean> {
  const r = await runPrompt({
    t: "prompt",
    protocol: PROTOCOL_VERSION,
    kind: "confirm",
    message: opts.message,
    ...(opts.initialValue !== undefined ? { default: opts.initialValue } : {}),
    ...(opts.destructive ? { destructive: true } : {}),
  });
  if (!("ok" in r)) throw new Error("rt-ui confirm: result had no ok");
  return r.ok;
}

export async function textInput(opts: {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  stderr?: boolean;
}): Promise<string> {
  const r = await runPrompt({
    t: "prompt",
    protocol: PROTOCOL_VERSION,
    kind: "text",
    title: opts.message,
    ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
    ...(opts.defaultValue !== undefined ? { initial: opts.defaultValue } : {}),
  });
  if (!("text" in r)) throw new Error("rt-ui text: result had no text");
  return r.text;
}
