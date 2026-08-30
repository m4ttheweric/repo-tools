/**
 * Step runner: one rt-ui spawn per step so nothing is alive between steps.
 * Static log lines between steps are the one presentation TS keeps; they
 * use the palette's truecolor so they match the helper's theme. Off a TTY
 * (agents, pipes, RT_BATCH) nothing is spawned and the same final line is
 * printed plainly, so every non-interactive path keeps its output.
 */
import { T, toAnsiFg } from "../tui/palette.ts";
import { interactive } from "./gate.ts";
import { openStep, type StepHandle } from "./spawn.ts";

export { __test__ } from "./gate.ts";

type StepStyle = "info" | "warn" | "error" | "success";

export interface StepRunner {
  /** Run an async step with spinner then done/error transition. */
  run<T>(
    pending: string,
    task: () => Promise<T>,
    opts?: { done?: string; doneHint?: string; error?: string; errorHint?: string },
  ): Promise<T>;

  /** Print a static line between steps. */
  log(message: string, style?: StepStyle): void;
}

const RESET = "\x1b[0m";
const GLYPH: Record<StepStyle, string> = {
  success: `${toAnsiFg(T.mint)}✓${RESET}`,
  error: `${toAnsiFg(T.coral)}✗${RESET}`,
  warn: `${toAnsiFg(T.peach)}⚠${RESET}`,
  info: `${toAnsiFg(T.dim)}•${RESET}`,
};

function stripEllipsis(s: string): string {
  return s.replace(/…$/, "");
}

function plainLine(style: "success" | "error", title: string, hint?: string): string {
  const h = hint ? `  ${toAnsiFg(T.faint)}${hint}${RESET}` : "";
  return `  ${GLYPH[style]} ${toAnsiFg(T.textSoft)}${title}${RESET}${h}\n`;
}

function warn(why: string): void {
  process.stderr.write(`  ${GLYPH.warn} ${toAnsiFg(T.dimmer)}rt-ui ${why}; printed plainly${RESET}\n`);
}

// A dead helper must never cost the user the result line: print it plainly
// and say why, then carry on.
function fallback(style: "success" | "error", title: string, hint: string | undefined, why: string): void {
  process.stdout.write(plainLine(style, title, hint));
  warn(why);
}

// The helper only narrates a step, so nothing about it may reach the caller as
// a failure: an unresolvable or unspawnable rt-ui leaves no handle, and the
// task then runs and reports itself on the plain path.
function tryOpenStep(pending: string): StepHandle | null {
  try {
    return openStep(pending);
  } catch (e) {
    warn(`could not start: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim()}`);
    return null;
  }
}

export function createStepRunner(): StepRunner {
  return {
    async run<T>(
      pending: string,
      task: () => Promise<T>,
      opts?: { done?: string; doneHint?: string; error?: string; errorHint?: string },
    ) {
      const step: StepHandle | null = interactive() ? tryOpenStep(pending) : null;
      try {
        const r = await task();
        const title = opts?.done ?? stripEllipsis(pending);
        if (!step) {
          process.stdout.write(plainLine("success", title, opts?.doneHint));
        } else if (!(await step.done(title, opts?.doneHint))) {
          fallback("success", title, opts?.doneHint, "exited before the step finished");
        }
        return r;
      } catch (e) {
        const hint = opts?.errorHint ?? (e instanceof Error ? e.message : undefined);
        const title = opts?.error ?? `${stripEllipsis(pending)} failed`;
        if (!step) {
          process.stdout.write(plainLine("error", title, hint));
        } else if (!(await step.fail(title, hint))) {
          fallback("error", title, hint, "exited before the step finished");
        }
        throw e;
      }
    },

    log(message, style = "info") {
      process.stdout.write(`  ${GLYPH[style]} ${toAnsiFg(T.textSoft)}${message}${RESET}\n`);
    },
  };
}

/** Legacy wrapper; use createStepRunner() for new code. */
export async function withSpinner<T>(
  label: string,
  task: () => Promise<T>,
  opts?: { doneLabel?: string; failLabel?: string },
): Promise<T> {
  return createStepRunner().run(label, task, { done: opts?.doneLabel, error: opts?.failLabel });
}
