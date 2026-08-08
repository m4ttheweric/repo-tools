import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redrawAnnotations, type RedrawDeps } from "../evidence-redraw.ts";
import type { EvidenceLedgerEntry } from "../daemon/evidence-ledger.ts";

const ENTRY: EvidenceLedgerEntry = {
  requestId: "r1",
  executor: "sidecar",
  sandboxId: "sb1",
  repoId: "demo",
  branch: "cv-1-fix",
  caseId: "c1",
  view: "v",
  recipe: "rec",
  slot: "after",
  state: "requested",
  requestedAt: "2026-08-08T00:00:00.000Z",
};

function redrawSetup() {
  const treeDir = mkdtempSync(join(tmpdir(), "rt-tree-"));
  const shots = mkdtempSync(join(tmpdir(), "rt-shots-"));
  const manifest = {
    capture: { viewport: { inner: [1280, 800], client: [1265, 800] } },
    annotateConfig: { annotations: [{ type: "blur", box: [1, 2, 3, 4] }] },
  };
  writeFileSync(join(treeDir, "after-rec-r1.json"), JSON.stringify(manifest));
  writeFileSync(join(treeDir, "after-rec-r1.png"), "png");
  const entry = {
    ...ENTRY, state: "synced",
    files: {
      base: join(treeDir, "after-rec-r1.png"),
      annotated: join(treeDir, "after-rec-r1.annotated.png"),
      manifest: join(treeDir, "after-rec-r1.json"),
    },
  } as EvidenceLedgerEntry;
  const execCalls: string[][] = [];
  const deps: RedrawDeps = {
    exec: async (argv) => {
      execCalls.push(argv);
      const cfg = JSON.parse(readFileSync(argv[2]!, "utf8"));
      const out = join(shots, cfg.out);
      writeFileSync(out, "annotated-png");
      return { exitCode: 0, stdout: JSON.stringify({ out }), stderr: "" };
    },
    editor: async (path) => {
      const cfg = JSON.parse(readFileSync(path, "utf8"));
      cfg.annotations.push({ type: "chip", xy: [10, 10], text: "case-specific callout" });
      writeFileSync(path, JSON.stringify(cfg));
    },
    screenshotsDir: () => shots,
    tmpDir: () => mkdtempSync(join(tmpdir(), "rt-cfg-")),
  };
  return { entry, deps, execCalls, shots };
}

describe("evidence-redraw", () => {
  test("happy redraw: base copied into screenshots, measured preserved, edited config drawn", async () => {
    const { entry, deps, execCalls, shots } = redrawSetup();
    const result = await redrawAnnotations(entry, deps);
    expect("annotatedPath" in result && result.annotatedPath.endsWith("redraw-r1-annotated.png")).toBe(true);
    expect(existsSync(join(shots, "redraw-r1.png"))).toBe(true);
    const drawnCfg = JSON.parse(readFileSync(execCalls[0]![2]!, "utf8"));
    expect(drawnCfg.base).toBe("redraw-r1.png");
    expect(drawnCfg.measured).toEqual({ schemaVersion: 1, viewport: { inner: [1280, 800], client: [1265, 800] } });
    expect(drawnCfg.annotations.length).toBe(2);   // structural blur + review-time callout
  });

  test("no annotateConfig in the manifest returns a clear error", async () => {
    const { entry, deps } = redrawSetup();
    writeFileSync(entry.files!.manifest, JSON.stringify({ capture: {} }));
    expect(await redrawAnnotations(entry, deps)).toEqual({ error: "no measured capture to redraw from" });
  });

  test("nonzero annotate exit surfaces stderr", async () => {
    const { entry, deps } = redrawSetup();
    deps.exec = async () => ({ exitCode: 2, stdout: "", stderr: "annotation 1 falls outside the image" });
    expect(await redrawAnnotations(entry, deps)).toEqual({ error: "annotation 1 falls outside the image" });
  });
});
