import type { Logger } from "pino";

export interface DaemonUnit {
  name: string;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

export async function runUnits(units: DaemonUnit[], log: Logger): Promise<void> {
  const started: DaemonUnit[] = [];
  for (const u of units) {
    try {
      await u.start();
      started.push(u);
    } catch (err) {
      await stopUnits(started, log);
      throw err;
    }
  }
}

export async function stopUnits(units: DaemonUnit[], log: Logger): Promise<void> {
  for (const u of [...units].reverse()) {
    try {
      await u.stop();
    } catch (err) {
      log.warn({ err, unit: u.name }, "daemon unit stop failed");
    }
  }
}
