import { daemonSocketQuery } from "../daemon-client.ts";

export type RunUpdate = { repo: string; runId: string; stage: string | null; kind: string };

// daemonSocketQuery, never daemonQuery: the latter restarts the daemon
// through the tray and waits on it, and a stage write must not do either.
// The DB write has already landed when this runs; a wedged daemon costs the
// timeout and nothing else.
export async function emitRunUpdated(update: RunUpdate, env: NodeJS.ProcessEnv = process.env, timeoutMs = 1_000): Promise<void> {
  if (env.RT_RUN_EMIT === "0") return;
  try {
    await daemonSocketQuery("events:emit", { topic: "run-updated", payload: update }, timeoutMs);
  } catch {
    // best effort by contract
  }
}
