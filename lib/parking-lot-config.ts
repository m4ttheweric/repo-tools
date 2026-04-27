/**
 * Parking-lot user config — whether the auto-park scan runs on each cache
 * refresh. Separate from `parking-lot-state.json`, which tracks transition
 * dedup internally.
 *
 * Defaults to enabled so behavior matches the shipped feature; `rt parking-lot
 * disable` is the escape hatch.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { RT_DIR } from "./daemon-config.ts";

export const PARKING_LOT_CONFIG_PATH = join(RT_DIR, "parking-lot.json");

export interface ParkingLotConfig {
  enabled: boolean;
}

export function loadParkingLotConfig(): ParkingLotConfig {
  try {
    const raw = JSON.parse(readFileSync(PARKING_LOT_CONFIG_PATH, "utf8"));
    return { enabled: raw?.enabled !== false };
  } catch {
    return { enabled: true };
  }
}

export function saveParkingLotConfig(config: ParkingLotConfig): void {
  try {
    mkdirSync(RT_DIR, { recursive: true });
    writeFileSync(PARKING_LOT_CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch { /* best-effort */ }
}
