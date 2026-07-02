/**
 * Silent, off-screen, browser-driven `sdm login`. Auth is SAML through the
 * org IdP and expires daily; with a warmed Chrome profile the whole flow
 * completes on cookies alone. Pure helpers here; the CDP orchestration is
 * appended below them (Task 4).
 *
 * Load-bearing facts (empirically validated): the IdP forces MFA on headless
 * Chrome, so the browser must run headful parked off-screen; and StrongDM's
 * SAML button only responds to a TRUSTED CDP mouse click, not a synthetic one.
 */

export interface ChromeCandidate {
  name: string;
  path: string;
}

// Google Chrome first (the profile is warmed there); then other Chromium-family
// browsers any of which can be CDP-driven. macOS app bundle paths.
export const CHROME_CANDIDATES: ChromeCandidate[] = [
  { name: "Google Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  { name: "Chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
  { name: "Brave", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
  { name: "Microsoft Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
];

export function detectChrome(
  exists: (p: string) => boolean,
  candidates: ChromeCandidate[] = CHROME_CANDIDATES,
): ChromeCandidate | null {
  return candidates.find(c => exists(c.path)) ?? null;
}

const LOGIN_URL_RE = /(https:\/\/\S*auth-confirm-native\/\S+)/;

export function extractLoginUrl(line: string): string | null {
  return line.match(LOGIN_URL_RE)?.[1] ?? null;
}

export type LoginNav = "complete" | "needs-user" | "progressing";

/**
 * Where the post-click redirect chain currently sits. `complete` is the
 * StrongDM success page. `needs-user` is an IdP sign-in / identity-verification
 * page (cold session, MFA required). Everything else is an in-flight SSO hop.
 */
export function classifyLoginNav(url: string): LoginNav {
  if (/\/app\/auth\/complete/.test(url)) return "complete";
  if (/\/sign-in|identity-verification/.test(url)) return "needs-user";
  return "progressing";
}
