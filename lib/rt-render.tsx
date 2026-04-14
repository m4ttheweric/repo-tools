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

// ─── Back Navigation ────────────────────────────────────────────────────────

/** Thrown by filterableSelect when the user picks the "↩ back" sentinel. */
export class BackNavigation extends Error {
  constructor() { super("back"); this.name = "BackNavigation"; }
}

const BACK = "__back__";

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
  backLabel?: string;
}): Promise<string> {
  // Prepend back sentinel if backLabel is provided
  const allOptions = opts.backLabel
    ? [{ value: BACK, label: `↩ ${opts.backLabel}`, hint: "" }, ...opts.options]
    : opts.options;

  // ink-ui's Option type doesn't have `hint`, so we bake it into the label
  const uiOptions = allOptions.map((o) => ({
    value: o.value,
    label: o.hint ? `${o.label}  \x1b[2m${o.hint}\x1b[22m` : o.label,
  }));

  const value = await prompt<string>(
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

  if (value === BACK) throw new BackNavigation();
  return value;
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
}): Promise<string[] | null> {
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

  // Build start binding to pre-select initialValues
  // Strategy: select-all, then deselect items NOT in initialValues
  const initialSet = new Set(opts.initialValues ?? []);
  const bindings: string[] = [];

  if (opts.initialValues !== undefined) {
    const actions: string[] = ["toggle-all"];
    // Deselect items that should NOT be selected
    for (let i = 0; i < opts.options.length; i++) {
      if (!initialSet.has(opts.options[i]!.value)) {
        actions.push(`pos(${i + 1})+toggle`);
      }
    }
    // Reset cursor to top
    actions.push("pos(1)");
    bindings.push(`--bind=start:${actions.join("+")}`);
  }

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
    "--header=space: toggle  tab: toggle & next  enter: confirm",
    "--no-mouse",
    "--bind=space:toggle,tab:toggle+down",
    "--preview=printf '%s\\n' {+2..}",
    "--preview-window=up,4,wrap,border-bottom",
    "--preview-label= selected ",
    ...bindings,
  ], {
    input,
    stdio: ["pipe", "pipe", "inherit"],
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return null;
  }

  if (!result.stdout?.trim()) {
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
  /** When set, appends a "↩ {backLabel}" sentinel. Throws BackNavigation when selected. */
  backLabel?: string;
}): Promise<string | null> {
  const { spawnSync, execSync } = await import("child_process");

  // Prepend back sentinel if backLabel is provided
  const options = opts.backLabel
    ? [{ value: BACK, label: `↩ ${opts.backLabel}`, hint: "" }, ...opts.options]
    : opts.options;

  let hasFzf = false;
  try {
    execSync("which fzf", { stdio: "pipe" });
    hasFzf = true;
  } catch {}

  if (!hasFzf) {
    return select({ ...opts, options });
  }

  const input = options
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
    return null;
  }

  const value = result.stdout.trim().split("\t")[0]!;
  if (value === BACK) throw new BackNavigation();
  return value;
}

// ─── Step Runner ─────────────────────────────────────────────────────────────

/**
 * A sequential step runner for CLI workflows.
 *
 * Each step transitions through states:
 *   pending  → spinner + title
 *   done     → ✓ title  description (dim)
 *   error    → ✗ title  description (dim)
 *
 * Static log lines (info, warn) can be interspersed between steps.
 *
 * Usage:
 *   const steps = createStepRunner();
 *   await steps.run("fetching origin…", async () => { ... }, { done: "origin fetched" });
 *   steps.log("rebasing onto origin/master");
 *   await steps.run("pushing…", async () => { ... }, { done: "pushed" });
 */

type StepStyle = "info" | "warn" | "error" | "success";

export interface StepRunner {
  /** Run an async step with spinner → done/error transition. */
  run<T>(
    pending: string,
    task: () => Promise<T>,
    opts?: { done?: string; doneHint?: string; errorHint?: string },
  ): Promise<T>;

  /** Print a static line between steps. */
  log(message: string, style?: StepStyle): void;
}

// ANSI helpers (inline to avoid import cycle with tui.ts)
const _green = "\x1b[32m";
const _red = "\x1b[31m";
const _yellow = "\x1b[33m";
const _dim = "\x1b[2m";
const _bold = "\x1b[1m";
const _reset = "\x1b[0m";

const ICONS = {
  success: `${_green}✓${_reset}`,
  error: `${_red}✗${_reset}`,
  warn: `${_yellow}⚠${_reset}`,
  info: `${_dim}•${_reset}`,
};

export function createStepRunner(): StepRunner {
  return {
    async run<T>(
      pending: string,
      task: () => Promise<T>,
      opts?: { done?: string; doneHint?: string; errorHint?: string },
    ): Promise<T> {
      const { Spinner } = await import("@inkjs/ui");

      return new Promise<T>((outerResolve, outerReject) => {
        let instance: Instance | undefined;

        instance = render(
          <Box marginLeft={1}>
            <Spinner label={pending} />
          </Box>,
          { exitOnCtrlC: true },
        );

        task()
          .then((r) => {
            instance?.clear();
            instance?.unmount();
            const title = opts?.done ?? pending.replace(/…$/, "");
            const hint = opts?.doneHint ? `  ${_dim}${opts.doneHint}${_reset}` : "";
            process.stdout.write(`  ${ICONS.success} ${title}${hint}\n`);
            outerResolve(r);
          })
          .catch((e) => {
            instance?.clear();
            instance?.unmount();
            const title = opts?.done ?? pending.replace(/…$/, " failed");
            const hint = opts?.errorHint
              ? `  ${_dim}${opts.errorHint}${_reset}`
              : e?.message
                ? `  ${_dim}${e.message}${_reset}`
                : "";
            process.stdout.write(`  ${ICONS.error} ${title}${hint}\n`);
            outerReject(e);
          });
      });
    },

    log(message: string, style: StepStyle = "info"): void {
      process.stdout.write(`  ${ICONS[style]} ${message}\n`);
    },
  };
}

/**
 * Legacy wrapper — use createStepRunner() for new code.
 */
export async function withSpinner<T>(
  label: string,
  task: () => Promise<T>,
  opts?: { doneLabel?: string; failLabel?: string },
): Promise<T> {
  const steps = createStepRunner();
  return steps.run(label, task, {
    done: opts?.doneLabel,
    errorHint: opts?.failLabel,
  });
}
