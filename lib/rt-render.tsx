/**
 * Thin wrapper around Ink's render() for one-shot prompts.
 *
 * Provides both:
 *   - prompt<T>(factory) for .tsx files that can use JSX
 *   - select(), confirm(), multiselect(), textInput() for .ts files
 *
 * Built on @inkjs/ui components.
 */

import React from "react";
import { render, Box, Text, type Instance } from "ink";
import {
  Select,
  MultiSelect,
  ConfirmInput,
  TextInput,
} from "@inkjs/ui";

// ─── Option type (matches @inkjs/ui) ────────────────────────────────────────

export interface SelectOption {
  value: string;
  label: string;
  /** Displayed as dim text after the label (not a native ink-ui prop — rendered manually) */
  hint?: string;
}

// ─── Core render helper ─────────────────────────────────────────────────────

/**
 * Render a one-shot Ink prompt and return the resolved value.
 * For use in .tsx files where JSX is available.
 */
export async function prompt<T>(
  factory: (resolve: (value: T) => void) => React.ReactElement,
  options?: { stderr?: boolean },
): Promise<T> {
  return new Promise<T>((outerResolve) => {
    let instance: Instance | undefined;

    const resolve = (value: T) => {
      if (instance) {
        instance.unmount();
      }
      outerResolve(value);
    };

    const element = factory(resolve);

    instance = render(element, {
      exitOnCtrlC: true,
      ...(options?.stderr ? { stdout: process.stderr } : {}),
    });

    instance.waitUntilExit().then(() => {
      // If we get here without resolve called, the user cancelled (process.exit)
    });
  });
}

// ─── Message + Component wrapper ────────────────────────────────────────────

function PromptFrame({
  message,
  children,
}: {
  message: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return React.createElement(
    Box,
    { flexDirection: "column" as const, marginTop: 1 },
    React.createElement(
      Box,
      { marginBottom: 1 },
      React.createElement(Text, { color: "cyan", bold: true }, "❯ "),
      React.createElement(Text, { bold: true }, message),
    ),
    children,
  );
}

// ─── Imperative wrappers for .ts files ──────────────────────────────────────

/**
 * Show a single-select prompt. Returns the selected value.
 * Exits on Ctrl+C.
 */
export async function select(opts: {
  message: string;
  options: SelectOption[];
  stderr?: boolean;
}): Promise<string> {
  // ink-ui's Option type doesn't have `hint`, so we bake it into the label
  const uiOptions = opts.options.map((o) => ({
    value: o.value,
    label: o.hint ? `${o.label}  \x1b[2m${o.hint}\x1b[22m` : o.label,
  }));

  return prompt<string>(
    (resolve) =>
      React.createElement(
        PromptFrame,
        { message: opts.message },
        React.createElement(Select, {
          options: uiOptions,
          onChange: resolve,
        }),
      ),
    { stderr: opts.stderr },
  );
}

/**
 * Show a multi-select prompt. Returns array of selected values.
 * Exits on Ctrl+C.
 */
export async function multiselect(opts: {
  message: string;
  options: SelectOption[];
  initialValues?: string[];
  required?: boolean;
  stderr?: boolean;
}): Promise<string[]> {
  const uiOptions = opts.options.map((o) => ({
    value: o.value,
    label: o.hint ? `${o.label}  \x1b[2m${o.hint}\x1b[22m` : o.label,
  }));

  return prompt<string[]>(
    (resolve) =>
      React.createElement(
        PromptFrame,
        { message: opts.message },
        React.createElement(MultiSelect, {
          options: uiOptions,
          defaultValue: opts.initialValues,
          onSubmit: resolve,
        }),
      ),
    { stderr: opts.stderr },
  );
}

/**
 * Show a yes/no confirmation as a two-option select.
 * Arrow keys to pick, enter to confirm. Matches the style of all other pickers.
 * Exits on Ctrl+C.
 */
export async function confirm(opts: {
  message: string;
  initialValue?: boolean;
  stderr?: boolean;
}): Promise<boolean> {
  const yesFirst = opts.initialValue !== false;
  const options = yesFirst
    ? [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ]
    : [
        { value: "no", label: "No" },
        { value: "yes", label: "Yes" },
      ];

  return prompt<boolean>(
    (resolve) =>
      React.createElement(
        PromptFrame,
        { message: opts.message },
        React.createElement(Select, {
          options,
          onChange: (value: string) => resolve(value === "yes"),
        }),
      ),
    { stderr: opts.stderr },
  );
}

/**
 * Show a text input prompt. Returns the entered string.
 * Exits on Ctrl+C.
 */
export async function textInput(opts: {
  message: string;
  placeholder?: string;
  stderr?: boolean;
}): Promise<string> {
  return prompt<string>(
    (resolve) =>
      React.createElement(
        PromptFrame,
        { message: opts.message },
        React.createElement(TextInput, {
          placeholder: opts.placeholder,
          onSubmit: resolve,
        }),
      ),
    { stderr: opts.stderr },
  );
}

/**
 * Show a filterable multi-select using fzf.
 * Selected items are shown in a preview pane at the top so you can always
 * see what you've picked, even when filtering.
 * Falls back to standard multiselect if fzf is not installed.
 */
export async function filterableMultiselect(opts: {
  message: string;
  options: SelectOption[];
  initialValues?: string[];
  stderr?: boolean;
}): Promise<string[]> {
  const { spawnSync, execSync } = await import("child_process");

  let hasFzf = false;
  try {
    execSync("which fzf", { stdio: "pipe" });
    hasFzf = true;
  } catch {}

  if (!hasFzf) {
    return multiselect(opts);
  }

  const input = opts.options
    .map((o) => `${o.value}\t\x1b[1m${o.label}\x1b[22m${o.hint ? `  \x1b[2m${o.hint}\x1b[22m` : ""}`)
    .join("\n");

  const result = spawnSync("fzf", [
    "--multi",
    "--ansi",
    "--with-nth=2..",
    "--delimiter=\t",
    "--height=~60%",
    "--layout=reverse",
    "--border=rounded",
    `--border-label= ${opts.message} `,
    "--prompt=filter: ",
    "--header=tab: toggle  enter: confirm  |: OR  !: exclude",
    "--no-mouse",
    "--bind=tab:toggle+down",
    "--preview=printf '%s\\n' {+2..}",
    "--preview-window=up,4,wrap,border-bottom",
    "--preview-label= selected ",
  ], {
    input,
    stdio: ["pipe", "pipe", "inherit"],
    encoding: "utf8",
  });

  if (result.status !== 0 || !result.stdout?.trim()) {
    return [];
  }

  return result.stdout
    .trim()
    .split("\n")
    .map((line) => line.split("\t")[0]!)
    .filter(Boolean);
}

/**
 * Show a filterable single-select using fzf.
 * Falls back to standard select if fzf is not installed.
 */
export async function filterableSelect(opts: {
  message: string;
  options: SelectOption[];
  stderr?: boolean;
}): Promise<string> {
  const { spawnSync, execSync } = await import("child_process");

  let hasFzf = false;
  try {
    execSync("which fzf", { stdio: "pipe" });
    hasFzf = true;
  } catch {}

  if (!hasFzf) {
    return select(opts);
  }

  const input = opts.options
    .map((o) => `${o.value}\t\x1b[1m${o.label}\x1b[22m${o.hint ? `  \x1b[2m${o.hint}\x1b[22m` : ""}`)
    .join("\n");

  const result = spawnSync("fzf", [
    "--ansi",
    "--with-nth=2..",
    "--delimiter=\t",
    "--height=~60%",
    "--layout=reverse",
    "--border=rounded",
    `--border-label= ${opts.message} `,
    "--prompt=filter: ",
    "--header=enter: select  |: OR  !: exclude",
    "--no-mouse",
  ], {
    input,
    stdio: ["pipe", "pipe", "inherit"],
    encoding: "utf8",
  });

  if (result.status !== 0 || !result.stdout?.trim()) {
    return "";
  }

  return result.stdout.trim().split("\t")[0]!;
}

// ─── Spinner helper ─────────────────────────────────────────────────────────

/**
 * Show an animated spinner while an async task runs.
 * The spinner is automatically removed when the task completes.
 */
export async function withSpinner<T>(
  label: string,
  task: () => Promise<T>,
): Promise<T> {
  const { Spinner } = await import("@inkjs/ui");

  let result: T;
  let error: unknown;

  return new Promise<T>((outerResolve, outerReject) => {
    let instance: Instance | undefined;

    const SpinnerView = () =>
      React.createElement(
        Box,
        { marginLeft: 1 },
        React.createElement(Spinner, { label }),
      );

    instance = render(React.createElement(SpinnerView), {
      exitOnCtrlC: true,
    });

    task()
      .then((r) => {
        result = r;
        instance?.unmount();
        outerResolve(result);
      })
      .catch((e) => {
        error = e;
        instance?.unmount();
        outerReject(error);
      });
  });
}

