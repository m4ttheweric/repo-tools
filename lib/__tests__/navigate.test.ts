import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildNavArgs } from "../navigate.ts";

describe("buildNavArgs preview", () => {
  const base = { options: [], message: "m" };

  test("omits preview args when preview is not set", () => {
    const args = buildNavArgs(base);
    expect(args.some((a) => a.startsWith("--preview"))).toBe(false);
    expect(args).not.toContain("--bind=ctrl-p:toggle-preview");
  });

  test("emits preview command, window, and toggle bind when preview is set", () => {
    const args = buildNavArgs({ ...base, preview: "echo {1}" });
    expect(args).toContain("--preview=echo {1}");
    expect(args).toContain("--preview-window=right,50%,border-line");
    expect(args).toContain("--bind=ctrl-p:toggle-preview");
  });
});

describe("buildNavArgs helpHeader", () => {
  const base = { options: [], message: "m" };

  test("hides the hints at start and toggles them with ctrl-/", () => {
    const args = buildNavArgs({ ...base, helpHeader: "line1\nline2" });
    expect(args).toContain("--header=line1\nline2");
    expect(args).toContain("--footer=ctrl-/: commands");
    expect(args).toContain("--bind=start:hide-header");
    expect(args).toContain("--bind=ctrl-/:toggle-header");
  });

  test("explicit header wins over helpHeader", () => {
    const args = buildNavArgs({ ...base, header: "esc: cancel", helpHeader: "hints" });
    expect(args).toContain("--header=esc: cancel");
    expect(args.some((a) => a.includes("toggle-header") || a.startsWith("--footer"))).toBe(false);
  });

  test("omits footer and toggle binds when helpHeader is not set", () => {
    const args = buildNavArgs(base);
    expect(args.some((a) => a.includes("toggle-header") || a.startsWith("--footer"))).toBe(false);
  });
});

describe("buildNavArgs live refresh", () => {
  const base = { options: [], message: "m" };

  test("omits listen and tracking args when no socket path is given", () => {
    const args = buildNavArgs(base);
    expect(args.some((a) => a.startsWith("--listen"))).toBe(false);
    expect(args).not.toContain("--track");
    expect(args).not.toContain("--id-nth=1");
  });

  test("emits listen and field-based tracking when a socket path is given", () => {
    const args = buildNavArgs(base, "/tmp/rt-nav-1.sock");
    expect(args).toContain("--listen=/tmp/rt-nav-1.sock");
    // Field 1 is the machine value column (d:src, f:readme.md), so the cursor
    // returns to the same entry after a reload instead of jumping to the top.
    expect(args).toContain("--track");
    expect(args).toContain("--id-nth=1");
  });
});

describe("buildNavArgs cyclic scroll", () => {
  test("always enables --cycle so the list wraps at both ends", () => {
    // Up at the top goes to the bottom, down at the bottom goes to the top.
    expect(buildNavArgs({ options: [], message: "m" })).toContain("--cycle");
  });
});

describe("runNavPicker fzf exit 1 (no match)", () => {
  /**
   * Fake fzf on a scratch PATH. fzf exits 1 when an --expect key is pressed
   * while no item is matched (list still streaming in, or the filter matches
   * nothing) — but it still prints the query and key lines. These fakes
   * reproduce exactly that stdout so the exit-status handling is exercised
   * without a tty.
   *
   * runNavPicker runs in a child bun process: Bun.spawn resolves the
   * executable against the environ PATH captured at process start, so an
   * in-process `process.env.PATH` mutation never reaches the fake — the PATH
   * has to be set on the child's environment at spawn time.
   */
  let binDir: string;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "nav-fzf-bin-"));
    writeFileSync(
      join(binDir, "picker-child.ts"),
      `const { runNavPicker } = await import(${JSON.stringify(join(import.meta.dir, "..", "navigate.ts"))});\n` +
        `const r = await runNavPicker(JSON.parse(process.env.NAV_OPTS));\n` +
        `console.log("RESULT:" + JSON.stringify(r));\n` +
        `process.exit(0);\n`,
    );
  });

  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  function pickWithFakeFzf(fzfBody: string, opts: Record<string, unknown> = {}): unknown {
    const shim = join(binDir, "fzf");
    writeFileSync(shim, `#!/bin/sh\ncat > /dev/null\n${fzfBody}`);
    chmodSync(shim, 0o755);
    const result = spawnSync(process.execPath, [join(binDir, "picker-child.ts")], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: process.env.HOME ?? "",
        NAV_OPTS: JSON.stringify({ options: [{ value: "a", label: "a" }], message: "m", ...opts }),
      },
    });
    const line = result.stdout.split("\n").find((l) => l.startsWith("RESULT:"));
    if (!line) throw new Error(`picker child produced no result: ${result.stdout}\n${result.stderr}`);
    return JSON.parse(line.slice("RESULT:".length));
  }

  test("honors a printed --expect key instead of discarding it as a cancel", () => {
    // ctrl-up during list load / on an empty filter: exit 1, key line printed.
    const result = pickWithFakeFzf("printf '\\nctrl-up\\n'\nexit 1\n");
    expect(result).toEqual({ value: null, key: "ctrl-up", query: "" });
  });

  test("exit 1 with no key pressed is still a cancel by default", () => {
    // Enter on a no-match query: no expect key, no selection.
    expect(pickWithFakeFzf("printf 'zz\\n\\n'\nexit 1\n")).toBeNull();
  });

  test("exit 1 with no key still resolves the query under captureQueryOnNoMatch", () => {
    const result = pickWithFakeFzf("printf 'zz\\n\\n'\nexit 1\n", { captureQueryOnNoMatch: true });
    expect(result).toEqual({ value: null, key: "", query: "zz" });
  });

  test("abort exits (130) remain cancels even with output printed", () => {
    expect(pickWithFakeFzf("printf '\\nctrl-up\\n'\nexit 130\n")).toBeNull();
  });
});
