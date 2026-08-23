/**
 * Shape guards for a host/URL a credential is about to be sent to. Used at
 * two different trust boundaries: rejecting a malformed value the user typed
 * themselves, and (separately, in integrations.ts) refusing to fetch at all
 * when the only candidate is team-declared rather than user-confirmed.
 */

const HOSTNAME_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;

/** A bare hostname: no scheme, no path, no userinfo, no port, no whitespace — exactly what gets prefixed with "https://" downstream. */
export function isValidHostname(host: string): boolean {
  const trimmed = host.trim();
  if (trimmed === "" || trimmed !== host) return false;
  if (trimmed.length > 253) return false;
  return HOSTNAME_RE.test(trimmed);
}

/** A full URL, https only, with a valid hostname and no embedded credentials. */
export function isValidHttpsUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  return isValidHostname(parsed.hostname);
}
