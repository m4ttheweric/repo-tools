/**
 * rt commit — GitHub Desktop-style staging, discarding, and commit flow.
 *
 * Presents a multi-picker of all changed files (staged + unstaged). All
 * files are pre-selected; deselect what you don't want. Each row's stats
 * column shows +adds/-dels for tracked files (from `git diff --numstat`) or
 * a `new` tag for untracked ones — no diff preview pane.
 *
 * Operations (mirrors GitHub Desktop's Changes tab):
 *   - space: stage/unstage (toggle inclusion in commit)
 *   - ctrl-d: discard working-tree changes for the file under the cursor
 *   - enter: commit staged selection
 *   - esc: abort
 *
 * Git mechanics live in lib/commit-ops.ts (tested there):
 *   1. Parse `git status --porcelain -z` → build file list
 *   2. filterableMultiselect with a right-pinned stats column
 *   3a. ctrl-d → confirm → discardChanges → back to step 1
 *   3b. enter → syncStagingArea → commit message → commitStaged → done
 *   3c. esc → abort
 */

import { createInterface } from "node:readline";
import type { CommandContext } from "../lib/command-tree.ts";
import { filterableMultiselect } from "../lib/pick-wrappers.ts";
import type { PickResult, PickRow, PickSegment } from "../lib/ui/protocol.ts";
import {
  getChangedFiles,
  discardChanges,
  syncStagingArea,
  commitStaged,
  numstatCounts,
  type ChangedFile,
  type NumstatCounts,
} from "../lib/commit-ops.ts";

// ─── Row building ─────────────────────────────────────────────────────────────

const STATUS_TONES: Record<string, string> = {
  A: "mint",
  M: "peach",
  D: "coral",
  R: "blue",
  C: "blue",
  U: "lav",
};

/** Path + marker left segments. Segment 0 is the row's label — the selected
 *  panel (rt-ui) reads only Left[0].Text for its mint dot-joined summary, so
 *  the marker must trail rather than lead. Staged changes color by status
 *  letter; unstaged changes render dim. */
function fileLeftSegments(f: ChangedFile): PickSegment[] {
  if (f.rawStatus === "??") {
    return [{ text: f.path }, { text: "  ??", tone: "faint" }];
  }
  const letter = f.isStaged ? f.rawStatus[0]! : f.rawStatus[1]!;
  const tone = f.isStaged ? (STATUS_TONES[letter] ?? "text") : "dim";
  return [{ text: f.path }, { text: `  ${f.rawStatus}`, tone }];
}

/** Stats right segments. Untracked files never appear in `git diff HEAD`, so
 *  numstat has nothing to report for them — a `new` tag stands in rather
 *  than a fabricated +0/-0. */
function fileRightSegments(f: ChangedFile, numstat: Map<string, NumstatCounts>): PickSegment[] {
  if (f.rawStatus === "??") {
    return [{ text: "new", tone: "faint" }];
  }
  const counts = numstat.get(f.path) ?? { adds: 0, dels: 0 };
  return [
    { text: `+${counts.adds}`, tone: "mint" },
    { text: " " },
    { text: `-${counts.dels}`, tone: "coral" },
  ];
}

function fileRow(f: ChangedFile, numstat: Map<string, NumstatCounts>): PickRow {
  return { value: f.path, left: fileLeftSegments(f), right: fileRightSegments(f, numstat) };
}

function errMessage(err: unknown): string {
  if (err instanceof Error && "stderr" in err) {
    const stderr = String((err as Error & { stderr: unknown }).stderr).trim();
    if (stderr) return stderr;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Inline confirmation before discarding. Mirrors GitHub Desktop's
 *  DiscardChanges dialog — always confirms, never discards silently. */
async function confirmDiscard(paths: string[]): Promise<boolean> {
  const label =
    paths.length === 1 ? `"${paths[0]}"` : `${paths.length} files`;
  process.stderr.write("\n");

  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    // The prompt must go through rl.question — readline's line refresh
    // clears the current line, erasing any text written directly before it.
    rl.question(`  discard changes to ${label}? [y/N] `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === "y" || trimmed === "yes");
    });
  });
}

// ─── picker ───────────────────────────────────────────────────────────────────

const DISCARD_ACTION_ID = "discard";

export interface PickerOutcome {
  action: "select" | "discard";
  paths: string[];
}

/**
 * Show the changed-files multiselect. ctrl-d is a global exit action outside
 * filterableMultiselect's own value/cancel contract (it collapses any
 * non-select action's result to `values ?? []`), so the live handle — given
 * out via onOpen — is read directly for the terminal PickResult. That's the
 * only way to tell "discard" apart from "select" or to reach the cursor row
 * a discard fired on.
 */
export async function runFilePicker(cwd: string, files: ChangedFile[]): Promise<PickerOutcome | null> {
  const numstat = numstatCounts(cwd);
  const rows = files.map((f) => fileRow(f, numstat));

  let raw: PickResult | undefined;
  const values = await filterableMultiselect(
    {
      message: "rt commit",
      options: [],
      initialValues: files.map((f) => f.path),
      breadcrumb: ["rt", "commit"],
    },
    {
      rows,
      actions: [{ id: DISCARD_ACTION_ID, label: "discard", key: "ctrl-d", scope: "global" }],
      onOpen: (h) => {
        void h.result.then((r) => {
          raw = r;
        });
      },
    },
  );

  if (values === null) return null;
  if (raw?.action === DISCARD_ACTION_ID) {
    return { action: "discard", paths: raw.values ?? (raw.value ? [raw.value] : []) };
  }
  return { action: "select", paths: values };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function commitFlow(_args: string[], ctx: CommandContext): Promise<void> {
  const cwd = ctx.identity!.repoRoot;

  // Loop: discard returns to the picker with a refreshed file list.
  // This mirrors GitHub Desktop — after discarding, the changes list updates in-place.
  while (true) {
    const files = getChangedFiles(cwd);
    if (files.length === 0) {
      process.stderr.write("\n  \x1b[2mnothing to commit — working tree clean\x1b[0m\n\n");
      process.exit(0);
    }

    const outcome = await runFilePicker(cwd, files);

    if (!outcome) {
      process.stderr.write("\n  \x1b[2maborted\x1b[0m\n\n");
      process.exit(0);
    }

    if (outcome.action === "discard") {
      if (outcome.paths.length === 0) {
        process.stderr.write("\n  \x1b[33mno file under cursor — nothing to discard\x1b[0m\n\n");
        continue;
      }

      const confirmed = await confirmDiscard(outcome.paths);
      if (!confirmed) {
        process.stderr.write("  \x1b[2mcancelled\x1b[0m\n\n");
        continue;
      }

      try {
        discardChanges(cwd, files, outcome.paths);
      } catch (err) {
        process.stderr.write(`  \x1b[31mdiscard failed:\x1b[0m ${errMessage(err)}\n`);
        continue;
      }
      const label = outcome.paths.length === 1 ? outcome.paths[0] : `${outcome.paths.length} files`;
      process.stderr.write(`  \x1b[32mdiscarded\x1b[0m ${label}\n`);
      // Loop back — next iteration rebuilds the file list from fresh git status
      continue;
    }

    if (outcome.paths.length === 0) {
      process.stderr.write("\n  \x1b[33mno files selected — nothing to commit\x1b[0m\n\n");
      process.exit(0);
    }

    try {
      syncStagingArea(cwd, files, new Set(outcome.paths));
    } catch (err) {
      process.stderr.write(`\n  \x1b[31mstaging failed:\x1b[0m ${errMessage(err)}\n\n`);
      process.exit(1);
    }

    const stagedList = outcome.paths.map((p) => `  \x1b[32m+\x1b[0m ${p}`).join("\n");
    process.stderr.write(`\n${stagedList}\n\n`);

    const { textInput } = await import("../lib/rt-render.ts");
    const message = await textInput({
      message: "Commit message",
      placeholder: "feat: ...",
    });

    if (!message.trim()) {
      // The staging changes from syncStagingArea are left in place (index now
      // matches the selection), so a plain `git commit` can pick up from here.
      process.stderr.write("\n  \x1b[33mempty message — commit aborted\x1b[0m\n\n");
      process.exit(0);
    }

    try {
      const summary = commitStaged(cwd, message.trim());
      process.stderr.write(`\n  \x1b[32m✔\x1b[0m ${summary}\n\n`);
      process.exit(0);
    } catch (err) {
      process.stderr.write(`\n  \x1b[31mcommit failed:\x1b[0m ${errMessage(err)}\n\n`);
      process.exit(1);
    }
  }
}
