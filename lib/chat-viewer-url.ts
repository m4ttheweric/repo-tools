import { getSetting } from "./settings/resolve.ts";

/**
 * The link rt prints for a room or a message when `chat.viewerUrl` is set.
 * The viewer serves `/r/<room>` and scrolls to `#m-<id>`; both halves are
 * owned by the chat app, so this is the one place rt spells that shape.
 */
export function chatViewerUrl(base: string | undefined, room: string, messageId?: number): string | undefined {
  if (!base) return undefined;
  const root = base.replace(/\/+$/, "");
  const anchor = messageId === undefined ? "" : `#m-${messageId}`;
  return `${root}/r/${encodeURIComponent(room)}${anchor}`;
}

/** `chat.viewerUrl`, or undefined when unset; the CLI's "posted → link" and
    the daemon's desk notification both go through here. The link is
    decoration on a post that has already succeeded, so an unreadable setting
    is reported and dropped rather than allowed to fail the post. */
export function readChatViewerUrlSetting(): string | undefined {
  try {
    const resolved = getSetting<string>("chat.viewerUrl");
    return typeof resolved.value === "string" && resolved.value ? resolved.value : undefined;
  } catch (err) {
    console.warn(`chat.viewerUrl could not be read, posting without a link: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
