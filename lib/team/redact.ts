/**
 * The one redactor every credential-bearing stderr/error path in this
 * package routes through, so a credential-bearing remote
 * (`https://x-access-token:TOKEN@host/...`) or a bare token git prints back
 * in its own rejection wording (`with token glpat-…`, `token=ghp_…`) never
 * reaches a thrown message, a `--json` envelope, or a log line.
 */

/** A whole URL is redacted regardless of shape — the exact URL doesn't matter, only that no credential-bearing substring survives. */
const URL_RE = /\bhttps?:\/\/\S+/g;
const SSH_REMOTE_RE = /\bgit@\S+:\S+/g;

/**
 * git's OWN rejection wording carries a bare token outside any URL (`HTTP
 * Basic: Access denied for user 'oauth2' with token glpat-SECRET`, `using
 * token=ghp_SECRET`) — neither URL pattern above touches it. Matched by the
 * high-entropy prefix every credential rt or a forge issues actually has,
 * so this never depends on which word came before it in the sentence.
 */
const CREDENTIAL_TOKEN_RE = /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abpsr]-|sk-ant-)[A-Za-z0-9_-]+/g;

/** Full redaction for free-text error messages, where the exact shape doesn't matter — only that no credential-bearing substring survives. */
export function withoutUrls(message: string): string {
  return message.replace(URL_RE, "<remote>").replace(SSH_REMOTE_RE, "<remote>").replace(CREDENTIAL_TOKEN_RE, "<redacted>");
}
