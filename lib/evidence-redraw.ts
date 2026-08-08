/**
 * Edit-and-redraw affordance for the evidence review gate.
 *
 * Reads a synced capture's manifest, copies its base PNG into the
 * fast-browser screenshots dir, prefills an annotate config from the
 * recipe's structural annotations, hands the config to $EDITOR for
 * case-specific callouts (chips, arrows, blurs), then redraws via
 * `fast-browser annotate`. No browser re-drive: annotate operates purely on
 * the already-captured base PNG plus the measured viewport recorded at
 * capture time.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceLedgerEntry } from "./daemon/evidence-ledger.ts";

export interface RedrawDeps {
  exec(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  editor(path: string): Promise<void>; // $EDITOR (fallback vi) on the config; resolves when closed
  screenshotsDir(): string; // ~/.fast-browser/screenshots, call-time HOME
  tmpDir(): string;
}

interface CaptureManifest {
  capture?: { viewport?: unknown };
  annotateConfig?: { annotations: unknown[] };
}

interface AnnotateReport {
  out: string;
}

export async function redrawAnnotations(
  entry: EvidenceLedgerEntry,
  deps: RedrawDeps,
): Promise<{ annotatedPath: string } | { error: string }> {
  if (!entry.files) return { error: "no measured capture to redraw from" };

  const manifest: CaptureManifest = JSON.parse(readFileSync(entry.files.manifest, "utf8"));
  if (!manifest.capture?.viewport) return { error: "no measured capture to redraw from" };
  if (!manifest.annotateConfig) return { error: "no measured capture to redraw from" };

  const requestId = entry.requestId;
  const shots = deps.screenshotsDir();
  mkdirSync(shots, { recursive: true });

  const baseName = `redraw-${requestId}.png`;
  copyFileSync(entry.files.base, join(shots, baseName));

  const outName = `redraw-${requestId}-annotated.png`;
  const configPath = join(deps.tmpDir(), `evidence-redraw-${requestId}.json`);
  const config = {
    base: baseName,
    out: outName,
    measured: { schemaVersion: 1, viewport: manifest.capture.viewport },
    annotations: manifest.annotateConfig.annotations,
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  // The human adds case-specific callouts or adjusts the structural ones
  // here. Recipes carry the structural plan; the callouts happen at review.
  await deps.editor(configPath);

  const result = await deps.exec(["fast-browser", "annotate", configPath, "--json"]);
  if (result.exitCode !== 0) return { error: result.stderr };

  const report: AnnotateReport = JSON.parse(result.stdout);
  return { annotatedPath: report.out };
}
