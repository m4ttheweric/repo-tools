import { test, expect } from "bun:test";
import { wrapCommand } from "../engine.ts";
import { TmuxEngine } from "../tmux-engine.ts";

const SOCK = "/tmp/x.sock";

function tracker() {
  const calls: string[][] = [];
  return { calls, push: (argv: string[]) => calls.push(argv) };
}

test("createWorkspace parses the new-session id pair and returns the socket as workspaceId", async () => {
  const { calls, push } = tracker();
  const engine = new TmuxEngine({
    socket: SOCK,
    sh: async (argv) => { push(argv); return { code: 0, stdout: "@0|%0", stderr: "" }; },
  });
  expect(await engine.createWorkspace("dev")).toEqual({ workspaceId: SOCK, tabId: "@0", paneId: "%0" });
  expect(calls[0]).toEqual(["tmux", "-S", SOCK, "new-session", "-d", "-s", "rt", "-n", "dev", "-x", "220", "-y", "50", "-P", "-F", "#{window_id}|#{pane_id}"]);
});

test("createWorkspace throws EngineError on a non-zero exit", async () => {
  const engine = new TmuxEngine({ socket: SOCK, sh: async () => ({ code: 1, stdout: "", stderr: "duplicate session: rt" }) });
  await expect(engine.createWorkspace("dev")).rejects.toMatchObject({ name: "EngineError" });
});

test("createTab parses the new-window id pair", async () => {
  const { calls, push } = tracker();
  const engine = new TmuxEngine({
    socket: SOCK,
    sh: async (argv) => { push(argv); return { code: 0, stdout: "@1|%1", stderr: "" }; },
  });
  expect(await engine.createTab(SOCK, "api")).toEqual({ tabId: "@1", paneId: "%1" });
  expect(calls[0]).toEqual(["tmux", "-S", SOCK, "new-window", "-t", "rt", "-n", "api", "-P", "-F", "#{window_id}|#{pane_id}"]);
});

test("renameTab issues rename-window", async () => {
  const { calls, push } = tracker();
  const engine = new TmuxEngine({ socket: SOCK, sh: async (argv) => { push(argv); return { code: 0, stdout: "", stderr: "" }; } });
  await engine.renameTab("@1", "api");
  expect(calls[0]).toEqual(["tmux", "-S", SOCK, "rename-window", "-t", "@1", "api"]);
});

test("run waits for the shell to go idle, then send-keys the literal wrapped command and Enter", async () => {
  const { calls, push } = tracker();
  let processInfoCalls = 0;
  const sh = async (argv: string[]) => {
    push(argv);
    const cmd = argv.join(" ");
    if (cmd.includes("display-message")) {
      processInfoCalls++;
      return { code: 0, stdout: "1000|/dev/ttys005|0", stderr: "" };
    }
    if (cmd.includes("ps -t")) {
      // First poll: shell still starting, foreground pgid != shell pid.
      // Second poll: the shell has reclaimed its own foreground.
      return { code: 0, stdout: processInfoCalls === 1 ? "1234" : "1000", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const engine = new TmuxEngine({ socket: SOCK, sh, sleep: async () => {} });
  await engine.run("%1", "/repo/web", "bun run dev");

  expect(processInfoCalls).toBe(2);
  const sendKeysCalls = calls.filter((a) => a.includes("send-keys"));
  expect(sendKeysCalls).toEqual([
    ["tmux", "-S", SOCK, "send-keys", "-t", "%1", "-l", wrapCommand("/repo/web", "bun run dev")],
    ["tmux", "-S", SOCK, "send-keys", "-t", "%1", "Enter"],
  ]);
  // The keys must not be sent until idle is confirmed: both processInfo
  // polls (display-message) happen before either send-keys call.
  const displayMessageIndices = calls.reduce<number[]>((acc, a, i) => (a.includes("display-message") ? [...acc, i] : acc), []);
  const firstSendKeysIndex = calls.findIndex((a) => a.includes("send-keys"));
  expect(firstSendKeysIndex).toBeGreaterThan(displayMessageIndices[displayMessageIndices.length - 1]!);
});

test("run sends anyway once waitIdle's timeout elapses", async () => {
  const { calls, push } = tracker();
  const sh = async (argv: string[]) => {
    push(argv);
    const cmd = argv.join(" ");
    if (cmd.includes("display-message")) return { code: 0, stdout: "1000|/dev/ttys005|0", stderr: "" };
    if (cmd.includes("ps -t")) return { code: 0, stdout: "1234", stderr: "" }; // always running
    return { code: 0, stdout: "", stderr: "" };
  };
  // A sleep that jumps the clock past the 4s waitIdle budget on its first call.
  let jumped = false;
  const realNow = Date.now;
  const engine = new TmuxEngine({
    socket: SOCK,
    sh,
    sleep: async () => {
      if (!jumped) {
        jumped = true;
        Date.now = () => realNow() + 5000;
      }
    },
  });
  try {
    await engine.run("%1", "/repo", "bun run dev");
  } finally {
    Date.now = realNow;
  }
  expect(calls.some((a) => a.includes("send-keys") && a.includes("-l"))).toBe(true);
});

test("interrupt sends C-c", async () => {
  const { calls, push } = tracker();
  const engine = new TmuxEngine({ socket: SOCK, sh: async (argv) => { push(argv); return { code: 0, stdout: "", stderr: "" }; } });
  await engine.interrupt("%1");
  expect(calls[0]).toEqual(["tmux", "-S", SOCK, "send-keys", "-t", "%1", "C-c"]);
});

test("processInfo maps pane_pid to shellPid and the first tpgid line to foregroundPgid", async () => {
  const engine = new TmuxEngine({
    socket: SOCK,
    sh: async (argv) => {
      const cmd = argv.join(" ");
      if (cmd.includes("display-message")) return { code: 0, stdout: "4242|/dev/ttys003|0", stderr: "" };
      if (cmd.includes("ps -t")) return { code: 0, stdout: "5555\n5555\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  expect(await engine.processInfo("%1")).toEqual({ foregroundPgid: 5555, shellPid: 4242, foreground: [] });
});

test("processInfo reports an idle shell when tpgid equals the pane's own pid", async () => {
  const engine = new TmuxEngine({
    socket: SOCK,
    sh: async (argv) => {
      const cmd = argv.join(" ");
      if (cmd.includes("display-message")) return { code: 0, stdout: "4242|/dev/ttys003|0", stderr: "" };
      if (cmd.includes("ps -t")) return { code: 0, stdout: "4242", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  expect(await engine.processInfo("%1")).toEqual({ foregroundPgid: 4242, shellPid: 4242, foreground: [] });
});

test("processInfo returns all-null for a dead pane, without calling ps", async () => {
  const { calls, push } = tracker();
  const engine = new TmuxEngine({
    socket: SOCK,
    sh: async (argv) => { push(argv); return { code: 0, stdout: "4242|/dev/ttys003|1", stderr: "" }; },
  });
  expect(await engine.processInfo("%1")).toEqual({ foregroundPgid: null, shellPid: null, foreground: [] });
  expect(calls).toHaveLength(1);
});

test("read issues capture-pane with -p -J and the negative line count", async () => {
  const { calls, push } = tracker();
  const engine = new TmuxEngine({
    socket: SOCK,
    sh: async (argv) => { push(argv); return { code: 0, stdout: "line one\nline two", stderr: "" }; },
  });
  expect(await engine.read("%1", 200)).toBe("line one\nline two");
  expect(calls[0]).toEqual(["tmux", "-S", SOCK, "capture-pane", "-p", "-J", "-t", "%1", "-S", "-200"]);
});

test("closeWorkspace sends kill-server and does not throw when the server is already gone", async () => {
  const engine = new TmuxEngine({ socket: SOCK, sh: async () => ({ code: 1, stdout: "", stderr: "no server running on socket x.sock" }) });
  await expect(engine.closeWorkspace(SOCK)).resolves.toBeUndefined();
});

test("focusTab throws no_herdr with no HERDR_PANE_ID in env", async () => {
  const engine = new TmuxEngine({ socket: SOCK, sh: async () => ({ code: 0, stdout: "", stderr: "" }), env: {} });
  await expect(engine.focusTab("@1")).rejects.toMatchObject({ name: "EngineError", code: "no_herdr" });
});

test("focusTab throws no_herdr when no herdr caller is injected", async () => {
  const engine = new TmuxEngine({ socket: SOCK, sh: async () => ({ code: 0, stdout: "", stderr: "" }), env: { HERDR_PANE_ID: "%0" } });
  await expect(engine.focusTab("@1")).rejects.toMatchObject({ name: "EngineError", code: "no_herdr" });
});

test("focusTab splits a fresh pane and attaches when no client is attached, then selects the window", async () => {
  const { calls, push } = tracker();
  const herdrCalls: { method: string; params: Record<string, unknown> }[] = [];
  const sh = async (argv: string[]) => {
    push(argv);
    if (argv.includes("list-clients")) return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const herdr = async (method: string, params: Record<string, unknown>) => {
    herdrCalls.push({ method, params });
    if (method === "pane.split") return { ok: true as const, result: { type: "pane_info", pane: { pane_id: "%9" } } };
    return { ok: true as const, result: {} };
  };
  const engine = new TmuxEngine({ socket: SOCK, sh, herdr, env: { HERDR_PANE_ID: "%0" }, sleep: async () => {} });
  await engine.focusTab("@1");

  expect(herdrCalls.map((c) => c.method)).toEqual(["pane.split", "pane.send_text", "pane.send_keys"]);
  expect(herdrCalls[0]!.params).toMatchObject({ pane_id: "%0", direction: "right", focus: true });
  expect(herdrCalls[1]!.params).toMatchObject({ pane_id: "%9", text: `tmux -S '${SOCK}' attach -t rt` });
  expect(herdrCalls[2]!.params).toMatchObject({ pane_id: "%9", keys: ["enter"] });
  expect(calls.some((a) => a.includes("select-window") && a.includes("@1"))).toBe(true);
});

test("focusTab only selects the window when a client is already attached", async () => {
  const { calls, push } = tracker();
  const herdrCalls: string[] = [];
  const sh = async (argv: string[]) => {
    push(argv);
    if (argv.includes("list-clients")) return { code: 0, stdout: "/dev/ttys004: rt (attached)", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const herdr = async (method: string) => { herdrCalls.push(method); return { ok: true as const, result: {} }; };
  const engine = new TmuxEngine({ socket: SOCK, sh, herdr, env: { HERDR_PANE_ID: "%0" } });
  await engine.focusTab("@1");

  expect(herdrCalls).toEqual([]);
  expect(calls.some((a) => a.includes("select-window") && a.includes("@1"))).toBe(true);
});

test("focusTab surfaces a herdr split failure as EngineError", async () => {
  const sh = async (argv: string[]) => (argv.includes("list-clients") ? { code: 0, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" });
  const herdr = async () => ({ ok: false as const, code: "no_pane", message: "pane gone" });
  const engine = new TmuxEngine({ socket: SOCK, sh, herdr, env: { HERDR_PANE_ID: "%0" } });
  await expect(engine.focusTab("@1")).rejects.toMatchObject({ name: "EngineError", code: "no_pane", message: "pane gone" });
});
