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
    { flexDirection: "column" as const },
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
 * Show a yes/no confirmation. Returns boolean.
 * Exits on Ctrl+C.
 */
export async function confirm(opts: {
  message: string;
  initialValue?: boolean;
  stderr?: boolean;
}): Promise<boolean> {
  return prompt<boolean>(
    (resolve) =>
      React.createElement(
        PromptFrame,
        { message: opts.message },
        React.createElement(ConfirmInput, {
          defaultChoice:
            opts.initialValue === false ? "cancel" : "confirm",
          onConfirm: () => resolve(true),
          onCancel: () => resolve(false),
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
