/**
 * Live listing refresh for rt nav.
 *
 * Turns filesystem events in one directory into `reload` actions POSTed to a
 * running fzf's --listen socket, so files that appear or disappear while the
 * picker is open show up without the user backing out and re-entering.
 *
 * The new listing goes to a file and the POST tells fzf to `cat` it. Passing it
 * inline would mean shell-escaping ANSI, tabs, and arbitrary filenames into a
 * command template, and the file is written before the POST so fzf's cat cannot
 * race it.
 */

import { watch as fsWatch, writeFileSync } from "fs";
import { shellQuote } from "./nav-fs.ts";

export interface NavWatchDeps {
  watch: (dir: string, listener: () => void) => { close(): void };
  post: (socketPath: string, body: string) => Promise<void>;
}

export interface NavWatchOpts {
  /** Directory to watch, non-recursively. */
  dir: string;
  /** Path of the running fzf's --listen unix socket. */
  socketPath: string;
  /** Path the regenerated listing is written to for fzf to cat. */
  listFile: string;
  /** The listing fzf already has, so an unchanged render sends nothing. */
  initial: string;
  /** Regenerates the formatted fzf input for the current directory state. */
  render: () => string;
  debounceMs?: number;
  onError?: (err: unknown) => void;
  deps?: Partial<NavWatchDeps>;
}

const defaultPost: NavWatchDeps["post"] = async (socketPath, body) => {
  await fetch("http://localhost/", { unix: socketPath, method: "POST", body });
};

const defaultWatch: NavWatchDeps["watch"] = (dir, listener) =>
  fsWatch(dir, { persistent: false }, () => listener());

export function startNavWatch(opts: NavWatchOpts): { stop(): void } {
  const watch = opts.deps?.watch ?? defaultWatch;
  const post = opts.deps?.post ?? defaultPost;
  const debounceMs = opts.debounceMs ?? 150;

  let lastSent = opts.initial;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let watcher: { close(): void } | null = null;

  const flush = () => {
    if (stopped) return;
    let next: string;
    try {
      next = opts.render();
    } catch (err) {
      // Directory deleted underneath us, or unreadable. Leave the last good
      // listing on screen rather than blanking the picker.
      opts.onError?.(err);
      return;
    }
    if (next === lastSent) return;
    try {
      writeFileSync(opts.listFile, next);
    } catch (err) {
      opts.onError?.(err);
      return;
    }
    const body = `reload(cat ${shellQuote(opts.listFile)})+refresh-preview`;
    post(opts.socketPath, body)
      .then(() => {
        // Only remember this listing as delivered once the POST actually
        // lands. Marking it sent beforehand would let a failed POST (e.g. fzf
        // has not yet bound its --listen socket) get silently swallowed by
        // the next-event guard above, with no retry.
        lastSent = next;
      })
      .catch(() => {
        // fzf exited between the debounce firing and the request landing, or
        // has not bound its socket yet. Either way, leaving lastSent
        // unadvanced means the next filesystem event resends this listing
        // instead of dropping it forever.
      });
  };

  try {
    watcher = watch(opts.dir, () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    });
  } catch (err) {
    // Unsupported filesystem or missing permissions. The picker still works,
    // it just will not refresh itself.
    opts.onError?.(err);
  }

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        watcher?.close();
      } catch {
        // Already closed.
      }
    },
  };
}
