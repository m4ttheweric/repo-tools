/**
 * Shared between `create.ts` and `publish.ts`: every git/gh failure message
 * this package throws routes through here first, so a credential-bearing
 * remote (`https://x-access-token:TOKEN@host/...`) never reaches a thrown
 * message, a `--json` envelope, or a log line.
 */

/** Full redaction for free-text error messages, where the exact URL shape doesn't matter — only that no credential-bearing substring survives. */
export function withoutUrls(message: string): string {
  return message.replace(/\bhttps?:\/\/\S+/g, "<remote>").replace(/\bgit@\S+:\S+/g, "<remote>");
}
