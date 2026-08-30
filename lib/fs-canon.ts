import { realpathSync } from "fs";

/**
 * realpathSync, degrading to the literal input when the path does not (yet)
 * exist -- a gone path must still compare, not throw. Never parent-walks: a
 * missing path's existing prefix is not canonicalized, so every caller sees
 * the same value for the same input regardless of what else on disk exists.
 */
export function canon(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
