/**
 * The hidden herdr session a `--hidden` herd runs its panes in: a named
 * herdr session off the user's visible one, addressed by its own socket.
 */
import { homedir } from "os";
import { join } from "path";

export const HIDDEN_SESSION = "herd";

export function hiddenSocketPath(home: string = process.env.HOME ?? homedir()): string {
  return join(home, ".config", "herdr", "sessions", HIDDEN_SESSION, "herdr.sock");
}
