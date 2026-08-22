// End-to-end validation of the browser-driven `rt sdm login` against a
// controlled fake IdP. The only part that cannot be automated (a real
// Rippling MFA/SAML login) is replaced by a local page with a "Log in with
// SAML" link that redirects to an /app/auth/complete path... everything else
// is the real stack: the compiled binary, startLoginCapture spawning a
// (stubbed) sdm that prints a real auth URL, the off-screen Chrome launch,
// raw CDP navigate + trusted click, Page.frameNavigated tracking, and
// complete-detection. Skips when no Chrome is installed.
//
// Chrome flavor detection mirrors lib/sdm/browser-login.ts CHROME_CANDIDATES.

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { existsSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { createTestHome } from "../harness.ts";
import { startInteractive, type TermwrightSession } from "../interactive.ts";

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const hasChrome = CHROME_PATHS.some(p => existsSync(p));
// Opt-in only: this drives a REAL Chrome, which briefly shows a window and
// steals focus on the running machine. Never run it as part of a normal
// `bun run test:e2e`; set RT_SDM_BROWSER_E2E=1 to run it deliberately.
const enabled = hasChrome && process.env.RT_SDM_BROWSER_E2E === "1";

describe.skipIf(!enabled)("rt sdm login (browser-driven, fake IdP)", () => {
  let home: string;
  let cleanupHome: () => void;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let session: TermwrightSession | null = null;
  let sentinel: string;
  let completeHits = 0;

  beforeAll(() => {
    ({ path: home, cleanup: cleanupHome } = createTestHome());
    sentinel = join(home, "auth-complete.sentinel");

    // Fake IdP: the auth-confirm page carries the SAML link; hitting the
    // complete path records it (so the stubbed sdm can exit) and returns ok.
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/auth-confirm-native/")) {
          return new Response(
            `<!doctype html><html><body>
               <h1>Almost there</h1>
               <a href="/app/auth/complete/">Log in with SAML</a>
             </body></html>`,
            { headers: { "content-type": "text/html" } },
          );
        }
        if (url.pathname.startsWith("/app/auth/complete")) {
          completeHits += 1;
          writeFileSync(sentinel, "done");
          return new Response("<!doctype html><html><body>ok</body></html>", {
            headers: { "content-type": "text/html" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const base = `http://127.0.0.1:${server.port}`;

    // Stub `sdm`: on `login`, print an auth URL pointing at the fake IdP, then
    // block until the browser reaches the complete path (sentinel appears),
    // then succeed... exactly the observable contract of the real CLI.
    const binDir = join(home, "fakebin");
    mkdirSync(binDir, { recursive: true });
    const fakeSdm = join(binDir, "sdm");
    writeFileSync(
      fakeSdm,
      `#!/bin/bash
if [ "$1" = "login" ]; then
  echo "Please complete logging in at: ${base}/auth-confirm-native/e2e123"
  for _ in $(seq 1 300); do
    [ -f "${sentinel}" ] && { echo "authentication successful"; exit 0; }
    sleep 0.1
  done
  echo "fake sdm: browser never completed" >&2
  exit 1
fi
if [ "$1" = "status" ]; then
  echo "authentication successful"; exit 0
fi
exit 0
`,
    );
    chmodSync(fakeSdm, 0o755);
  });

  afterEach(async () => {
    if (session) {
      await session.stop();
      session = null;
    }
  });

  afterAll(() => {
    server?.stop(true);
    cleanupHome();
  });

  test("silent path drives the fake SAML flow to completion", async () => {
    const fakeSdm = join(home, "fakebin", "sdm");
    // sdmEmail must be set or the orchestrator returns needs-manual before
    // ever launching a browser (the email preflight) — SDM_EMAIL overrides
    // the encrypted store for exactly this preflight read.
    session = await startInteractive({
      args: ["sdm", "login"],
      home,
      env: { RT_SDM_BIN: fakeSdm, SDM_EMAIL: "nobody@example.test" },
      timeoutMs: 20_000,
    });

    // The whole drive (spawn sdm, launch off-screen Chrome, CDP navigate +
    // click, reach complete) should finish well inside this budget.
    await session.waitForText("logged in", 45_000);
    const screen = await session.screen();
    expect(screen).toContain("logged in");
    expect(completeHits).toBeGreaterThan(0);
  }, 90_000);
});
