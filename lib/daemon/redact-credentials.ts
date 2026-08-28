/**
 * Strips userinfo (user:token@ or user@) out of any http(s) URL embedded in
 * a string. freshness.ts logs `remote.origin.url` verbatim on every
 * reconcile and echoes it into thrown errors returned to callers; a repo
 * cloned as `https://oauth2:glpat-XXXX@gitlab.example.com/...` (routine for
 * dotfiles/CI-derived clones) puts that token into ~/.rt/logs/daemon.*.log
 * and into any client-facing error message. Logs are the first thing a user
 * pastes into a bug report.
 */
const CREDENTIAL_URL_RE = /(https?:\/\/)[^/@\s]+@/gi;

export function redactCredentials(text: string): string {
  return text.replace(CREDENTIAL_URL_RE, "$1[redacted]@");
}
