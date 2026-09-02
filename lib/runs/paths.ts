import { homedir } from "os";
import { join } from "path";

export function runsRoot(): string {
  return process.env.RT_RUNS_ROOT ?? join(homedir(), ".mattstack", "runs");
}

// repo/runId reach a path join straight from a network-reachable readonly
// seam (runs:get via REST decodes %2F): reject anything that could step
// outside <runsRoot>/<repo>/<runId> before it ever hits the filesystem.
export function isPathComponent(s: string): boolean {
  return s.length > 0 && s !== "." && s !== ".." && !s.includes("/") && !s.includes("\\");
}
