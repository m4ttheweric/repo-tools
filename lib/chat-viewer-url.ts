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
