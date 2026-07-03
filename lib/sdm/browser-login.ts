/**
 * Browser-driven `sdm login`. Auth is SAML through the org IdP and expires
 * daily; with a warmed Chrome profile the whole flow completes on cookies
 * alone in a few seconds. Pure helpers here; the CDP orchestration is
 * appended below them (Task 4).
 *
 * The browser is a small on-screen chromeless popup (Chrome `--app` mode),
 * like a native OAuth popup, driven over CDP. Load-bearing facts (empirically
 * validated): the IdP forces MFA on headless Chrome (so it must be headful);
 * an on-screen window is required for the click to land (an off-screen window
 * does not lay out, so getBoundingClientRect returns nothing); and StrongDM's
 * SAML button only responds to a TRUSTED CDP mouse click, not a synthetic one.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { browserWebSocketUrl, connectCdp, type CdpSocket } from "./cdp.ts";
import { startLoginCapture, invalidateSdmSnapshotCache, type LoginUrlCapture } from "./core.ts";
import { loadSecrets } from "../linear.ts";
import { withTimeout } from "./verify.ts";

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

const LOGIN_URL_RE = /(https?:\/\/\S*auth-confirm-native\/\S+)/;

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

// ---------------------------------------------------------------------------
// Orchestrator + real deps (Task 4)
// ---------------------------------------------------------------------------

export type BrowserLoginOutcome =
  | { outcome: "authenticated" }
  | { outcome: "needs-manual"; reason: string }
  | { outcome: "failed"; error: string };

export interface BrowserLoginDeps {
  detectChrome: () => ChromeCandidate | null;
  freePort: () => Promise<number>;
  launchChrome: (chromePath: string, port: number, profileDir: string, url: string) => { pid: number; kill: () => void };
  waitForCdp: (port: number, timeoutMs: number) => Promise<CdpSocket>;
  startLogin: (email: string | null, onLine: (l: string) => void) => LoginUrlCapture;
  showWindow: (cdp: CdpSocket) => Promise<void>;
  email: () => string | null;
  onLine: (line: string) => void;
  silentBudgetMs?: number;
  userBudgetMs?: number;
}

export function chromeProfileDir(): string {
  return join(homedir(), ".rt", "sdm", "chrome-profile");
}

const BUTTON_RECT_EXPR = `(() => {
  const el = [...document.querySelectorAll('button, a')].find(e => /log in with saml/i.test(e.textContent || ''));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return (r.width && r.height) ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
})()`;

async function evalValue(cdp: CdpSocket, expression: string): Promise<any> {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  return r?.result?.value ?? null;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function runBrowserLoginWith(
  deps: BrowserLoginDeps & { visible: boolean },
): Promise<BrowserLoginOutcome> {
  const chrome = deps.detectChrome();
  if (!chrome) {
    return { outcome: "needs-manual", reason: "No Chrome or Chromium browser found." };
  }
  // Silent login is the default path now. Without an email set, sdm's login
  // prompts for one on stdin, which is closed in this flow, so it exits with
  // a cryptic "before printing an auth URL" error. Route to the terminal
  // flow instead, where sdm can prompt for the email naturally.
  const email = deps.email();
  if (!email || !email.trim()) {
    return {
      outcome: "needs-manual",
      reason: "StrongDM email not set. Run `rt sdm set-email` (or use `rt sdm login --manual`).",
    };
  }
  const silentBudget = deps.silentBudgetMs ?? 10_000;
  const userBudget = deps.userBudgetMs ?? 180_000;

  let capture: LoginUrlCapture | null = null;
  let chromeProc: { kill: () => void } | null = null;
  let cdp: CdpSocket | null = null;
  let succeeded = false;

  // Ctrl-C mid-login must not orphan the login Chrome: it is spawned
  // non-detached, but the process can still die here (async awaits) before
  // the `finally` below ever runs, leaving a Chrome holding the profile's
  // SingletonLock and poisoning every future login until someone manually
  // kills it. Kill what we launched and exit immediately.
  const onSignal = () => {
    chromeProc?.kill();
    capture?.cancel();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    // Started inside the try: the real startLogin does synchronous fs work
    // (mkdtemp/write/chmod for the `open` shim) that can throw.
    capture = deps.startLogin(email, deps.onLine);
    const url = await withTimeout(capture.urlPromise, 20_000, "sdm login URL capture");
    const port = await deps.freePort();
    chromeProc = deps.launchChrome(chrome.path, port, chromeProfileDir(), url);
    cdp = await deps.waitForCdp(port, 15_000);

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    // Track the live URL from pushed main-frame navigations (no polling).
    let currentUrl = url;
    cdp.on("Page.frameNavigated", (p) => {
      if (p?.frame && !p.frame.parentId && typeof p.frame.url === "string") currentUrl = p.frame.url;
    });

    await cdp.send("Page.navigate", { url });

    // Click the SAML button (trusted). Poll briefly for it to render.
    const clickDeadline = Date.now() + 15_000;
    let clicked = false;
    while (Date.now() < clickDeadline) {
      if (/\/app\/auth\/complete/.test(currentUrl)) { clicked = true; break; }
      const rect = await evalValue(cdp, BUTTON_RECT_EXPR);
      if (rect) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
        clicked = true;
        break;
      }
      await sleep(400);
    }
    if (!clicked) return { outcome: "failed", error: "Could not find the SAML button." };

    // Wait for the redirect chain, escalating to a visible window on a cold
    // (MFA) session. Event-driven: we read currentUrl updated by the listener.
    let escalated = deps.visible;
    const deadlineAt = () => Date.now() + (escalated ? userBudget : silentBudget);
    let deadline = deadlineAt();
    for (;;) {
      const nav = classifyLoginNav(currentUrl);
      if (nav === "complete") break;
      if (nav === "needs-user" && !escalated) {
        escalated = true;
        await deps.showWindow(cdp);
        deps.onLine("Complete the StrongDM sign-in in the window that opened.");
        deadline = deadlineAt();
      }
      if (Date.now() > deadline) {
        // A cold session is either a needs-user URL (handled above) or simply
        // not reaching auth/complete within the silent budget. Both escalate
        // on-screen the same way instead of failing outright; only fail once
        // we're already on-screen and the (longer) user budget also expires.
        if (escalated) return { outcome: "failed", error: "Login not completed in time." };
        escalated = true;
        await deps.showWindow(cdp);
        deps.onLine("Complete the StrongDM sign-in in the window that opened.");
        deadline = deadlineAt();
      }
      // Short tick: this only re-reads a local variable kept live by the
      // frameNavigated listener (no CDP round trip), so a tight interval is
      // cheap and avoids missing a transient needs-user hop that a later
      // navigation quickly overwrites.
      await sleep(25);
    }

    const done = await withTimeout(capture.donePromise, 10_000, "sdm login completion");
    if (!done.ok) return { outcome: "failed", error: `sdm login exited unsuccessfully: ${done.output.trim().slice(0, 200)}` };
    invalidateSdmSnapshotCache();
    succeeded = true;
    return { outcome: "authenticated" };
  } catch (e) {
    return { outcome: "failed", error: (e as Error).message };
  } finally {
    // Remove the signal handlers here (not just on success) so a second
    // call to this function in the same process never stacks listeners.
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    // Every non-authenticated exit (early returns above and thrown errors)
    // must not leave the `sdm login` subprocess blocked waiting for a
    // browser completion that will never come. Cancelling a capture whose
    // process already exited (the success path) is a harmless no-op kill.
    if (!succeeded) capture?.cancel();
    cdp?.close();
    chromeProc?.kill();
  }
}

function realFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

// Compact, chromeless auth popup: `--app` opens a single window with no tabs
// or address bar (like a native OAuth popup) already showing the auth URL, at
// a typical popup size. On-screen and visible on purpose... an on-screen
// window actually lays out, so getBoundingClientRect and the trusted click
// work reliably (an off-screen window does not render, which broke the click).
function realLaunchChrome(chromePath: string, port: number, profileDir: string, url: string) {
  mkdirSync(profileDir, { recursive: true });
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    // A fresh profile otherwise pops a blocking macOS "keychain cannot be
    // found to store Chrome" dialog (Chrome Safe Storage). These keep Chrome
    // off the system keychain entirely.
    "--use-mock-keychain",
    "--password-store=basic",
    "--window-size=480,660",
    "--window-position=560,180",
    `--app=${url}`,
  ];
  const proc = spawn(chromePath, args, { stdio: "ignore", detached: false });
  return { pid: proc.pid ?? -1, kill: () => { try { proc.kill("SIGKILL"); } catch {} } };
}

async function realWaitForCdp(port: number, timeoutMs: number): Promise<CdpSocket> {
  const start = Date.now();
  for (;;) {
    try {
      const wsUrl = await browserWebSocketUrl(port);
      const cdp = await connectCdp(wsUrl);
      // Attach to the single page the --app window already opened. Target.
      // createTarget would spawn a SECOND window; here there is exactly one
      // popup and we drive it directly.
      const targets = await cdp.send("Target.getTargets");
      const page = (targets?.targetInfos ?? []).find((t: any) => t.type === "page");
      if (!page) throw new Error("no page target yet");
      const attached = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      const sessionId = attached.sessionId as string;
      // Wrap so all sends carry the session by default.
      return {
        send: (method, params, sid) => cdp.send(method, params, sid ?? sessionId),
        on: (event, cb) => cdp.on(event, cb),
        close: () => cdp.close(),
      };
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error("Chrome CDP endpoint did not come up.");
      await sleep(200);
    }
  }
}

async function realShowWindow(cdp: CdpSocket): Promise<void> {
  try {
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 120, top: 120, width: 1100, height: 800, windowState: "normal" } });
  } catch {
    // If bounds control fails, the login can still be completed by the user if
    // any window is reachable; do not hard-fail here.
  }
}

export function runBrowserLogin(opts: { visible?: boolean; onLine?: (line: string) => void }): Promise<BrowserLoginOutcome> {
  const onLine = opts.onLine ?? (() => {});
  return runBrowserLoginWith({
    visible: opts.visible ?? false,
    detectChrome: () => detectChrome(existsSync),
    freePort: realFreePort,
    launchChrome: realLaunchChrome,
    waitForCdp: realWaitForCdp,
    startLogin: startLoginCapture,
    showWindow: realShowWindow,
    email: () => loadSecrets().sdmEmail ?? null,
    onLine,
  });
}
