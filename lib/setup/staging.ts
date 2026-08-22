/**
 * Staged secrets — a durable holding pen for values collected during `rt
 * setup` before the secrets.write step has a live secrets store to target.
 * One file per domain: ~/.mattstack/rt/setup-staging/<domain>.json (0600).
 */

import { join } from "path";
import type { Probes } from "./probes.ts";

export function stagingDir(home: string): string {
  return join(home, ".mattstack", "rt", "setup-staging");
}

function domainPath(home: string, domain: string): string {
  return join(stagingDir(home), `${domain}.json`);
}

function readDomainFile(p: Probes, path: string): Record<string, string> {
  const raw = p.readFile(path);
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export function stageSecret(p: Probes, domain: string, key: string, value: string): void {
  const path = domainPath(p.home, domain);
  const staged = readDomainFile(p, path);
  staged[key] = value;
  p.mkdirp(stagingDir(p.home));
  p.writeFile(path, JSON.stringify(staged), 0o600);
}

export function listStaged(p: Probes): { domain: string; key: string }[] {
  const dir = stagingDir(p.home);
  const result: { domain: string; key: string }[] = [];
  for (const file of p.readDir(dir)) {
    if (!file.endsWith(".json")) continue;
    const domain = file.slice(0, -".json".length);
    for (const key of Object.keys(readDomainFile(p, join(dir, file)))) result.push({ domain, key });
  }
  return result;
}

/**
 * A write that throws mid-domain must leave that domain's file untouched —
 * the caller retries the whole batch next time, not just the missed key —
 * so the file is only removed once every key in it has succeeded, and the
 * throw propagates instead of being caught here.
 */
export async function drainStaged(p: Probes, write: (domain: string, key: string, value: string) => Promise<void>): Promise<number> {
  const dir = stagingDir(p.home);
  let count = 0;
  for (const file of p.readDir(dir)) {
    if (!file.endsWith(".json")) continue;
    const domain = file.slice(0, -".json".length);
    const path = join(dir, file);
    const staged = readDomainFile(p, path);
    for (const [key, value] of Object.entries(staged)) {
      await write(domain, key, value);
      count++;
    }
    p.removeFile(path);
  }
  return count;
}
