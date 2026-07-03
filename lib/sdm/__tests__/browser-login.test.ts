import { describe, test, expect } from "bun:test";
import { runBrowserLoginWith, type BrowserLoginDeps } from "../browser-login.ts";
import type { CdpSocket } from "../cdp.ts";

// A fake CDP socket: Runtime.evaluate returns a button rect / current href on
// demand; Input.dispatchMouseEvent records the click; the test drives
// Page.frameNavigated events via emit().
function fakeCdp(script: {
  buttonRect?: { x: number; y: number };
  href: () => string;
}): { cdp: CdpSocket; clicks: number; emit: (url: string) => void } {
  const listeners: Array<(p: any) => void> = [];
  let clicks = 0;
  const cdp: CdpSocket = {
    async send(method, params) {
      if (method === "Runtime.evaluate") {
        const expr = String(params?.expression ?? "");
        if (expr.includes("getBoundingClientRect") || expr.includes("querySelectorAll")) {
          return { result: { value: script.buttonRect ?? null } };
        }
        if (expr.includes("location.href")) return { result: { value: script.href() } };
        return { result: { value: null } };
      }
      if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") clicks++;
      return {};
    },
    on(event, cb) {
      if (event === "Page.frameNavigated") listeners.push(cb as any);
    },
    close() {},
  };
  return { cdp, get clicks() { return clicks; }, emit: (url: string) => listeners.forEach(cb => cb({ frame: { url, parentId: undefined } })) };
}

function baseDeps(over: Partial<BrowserLoginDeps> & { visible?: boolean } = {}) {
  const killed = { count: 0 };
  const f = fakeCdp({ buttonRect: { x: 100, y: 200 }, href: () => "https://app.strongdm.com/auth-confirm-native/x" });
  let capDone!: (v: any) => void;
  const deps: BrowserLoginDeps & { visible: boolean } = {
    detectChrome: () => ({ name: "Google Chrome", path: "/chrome" }),
    freePort: async () => 12345,
    launchChrome: () => ({ pid: 1, kill: () => { killed.count++; } }),
    waitForCdp: async () => f.cdp,
    startLogin: (_e, _o) => ({
      urlPromise: Promise.resolve("https://app.strongdm.com/auth-confirm-native/x"),
      donePromise: new Promise(res => { capDone = res; }),
      cancel: () => {},
    }),
    showWindow: async () => {},
    email: () => "nobody@example.test",
    onLine: () => {},
    silentBudgetMs: 500,
    userBudgetMs: 1000,
    visible: false,
    ...over,
  };
  return { deps, fake: f, killed, completeLogin: () => capDone({ ok: true, output: "", spawnErrorCode: null, exitCode: 0 }) };
}

describe("runBrowserLoginWith", () => {
  test("no Chrome -> needs-manual, nothing launched", async () => {
    const { deps } = baseDeps({ detectChrome: () => null });
    const r = await runBrowserLoginWith(deps);
    expect(r.outcome).toBe("needs-manual");
  });

  test("no sdmEmail set -> needs-manual, never starts sdm login or launches Chrome", async () => {
    const calls = { startLogin: 0, launchChrome: 0 };
    const { deps } = baseDeps({
      email: () => null,
      startLogin: (_e, _o) => {
        calls.startLogin++;
        return {
          urlPromise: Promise.resolve("https://app.strongdm.com/auth-confirm-native/x"),
          donePromise: new Promise(() => {}),
          cancel: () => {},
        };
      },
      launchChrome: () => {
        calls.launchChrome++;
        return { pid: 1, kill: () => {} };
      },
    });
    const r = await runBrowserLoginWith(deps);
    expect(r).toEqual({
      outcome: "needs-manual",
      reason: "StrongDM email not set. Run `rt sdm set-email` (or use `rt sdm login --manual`).",
    });
    expect(calls.startLogin).toBe(0);
    expect(calls.launchChrome).toBe(0);
  });

  test("warm session: click, reach complete, authenticated, Chrome killed", async () => {
    const { deps, fake, killed, completeLogin } = baseDeps();
    const p = runBrowserLoginWith(deps);
    // Drive the redirect chain to completion, then let sdm login exit.
    setTimeout(() => { fake.emit("https://app.strongdm.com/app/auth/complete/"); completeLogin(); }, 50);
    const r = await p;
    expect(r.outcome).toBe("authenticated");
    expect(fake.clicks).toBe(1);
    expect(killed.count).toBe(1);
  });

  test("cold session: needs-user escalates to visible, then completes", async () => {
    let shown = false;
    const { deps, fake, completeLogin } = baseDeps({ visible: false, showWindow: async () => { shown = true; } });
    const p = runBrowserLoginWith(deps);
    setTimeout(() => fake.emit("https://app.rippling.com/sign-in/identity-verification/select"), 30);
    setTimeout(() => { fake.emit("https://app.strongdm.com/app/auth/complete/"); completeLogin(); }, 120);
    const r = await p;
    expect(shown).toBe(true);
    expect(r.outcome).toBe("authenticated");
  });

  test("silent budget expiring with no user progress -> escalates on-screen, then failed", async () => {
    let shown = false;
    const { deps } = baseDeps({
      visible: false,
      silentBudgetMs: 100,
      userBudgetMs: 200,
      showWindow: async () => { shown = true; },
    });
    // Never emit complete or needs-user; the silent budget expiring on its
    // own must escalate on-screen just like an explicit needs-user URL does,
    // then fail once the (longer) user budget also expires with no progress.
    const r = await runBrowserLoginWith(deps);
    expect(shown).toBe(true);
    expect(r.outcome).toBe("failed");
  });

  test("SIGINT/SIGTERM listeners are added during a run and removed after (no stacking)", async () => {
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");
    const { deps, fake, completeLogin } = baseDeps();
    const p = runBrowserLoginWith(deps);
    setTimeout(() => { fake.emit("https://app.strongdm.com/app/auth/complete/"); completeLogin(); }, 50);
    await p;
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
  });

  test("silent budget expiring cancels the in-flight login capture", async () => {
    const cancelled = { called: false };
    const { deps } = baseDeps({
      visible: false,
      silentBudgetMs: 100,
      userBudgetMs: 200,
      showWindow: async () => {},
      startLogin: (_e, _o) => ({
        urlPromise: Promise.resolve("https://app.strongdm.com/auth-confirm-native/x"),
        donePromise: new Promise(() => {}),
        cancel: () => { cancelled.called = true; },
      }),
    });
    // Never emit complete; stays progressing then times out without ever
    // reaching the catch block -- this is a plain `return` inside the try.
    const r = await runBrowserLoginWith(deps);
    expect(r.outcome).toBe("failed");
    expect(cancelled.called).toBe(true);
  });
});
