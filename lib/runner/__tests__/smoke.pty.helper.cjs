/* eslint-disable */
/**
 * PTY bridge helper — run via `node` from the smoke test.
 *
 * node-pty is a native addon that hangs under Bun (the master fd isn't wired
 * into Bun's libuv loop the way node-pty expects), so we can't spawn PTYs
 * directly from `bun test`. Instead, bun:test spawns *this* script under node,
 * and this script forwards bytes between its own stdin/stdout and the PTY.
 *
 * Protocol: line-delimited JSON on stdin.
 *   {"op":"spawn","file":"/path/to/bun","args":[...],"cwd":"...","env":{...},"cols":120,"rows":40}
 *   {"op":"input","data":"..."}        — bytes to write to the PTY
 *   {"op":"resize","cols":120,"rows":40}
 *   {"op":"kill"}
 *
 * stdout frames — also line-delimited JSON:
 *   {"ev":"spawned","pid":123}
 *   {"ev":"data","data":"<base64-encoded pty output>"}
 *   {"ev":"exit","code":0,"signal":null}
 *   {"ev":"error","message":"..."}
 *
 * Everything is base64 on the data channel so control characters don't break
 * the line-delimited framing. stderr is reserved for unexpected errors only.
 */

const readline = require("readline");

let pty;
try {
  pty = require("node-pty");
} catch (err) {
  process.stdout.write(JSON.stringify({ ev: "error", message: `node-pty require failed: ${String(err)}` }) + "\n");
  process.exit(2);
}

let term = null;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch { return; }

  try {
    if (msg.op === "spawn") {
      if (term) return; // already running
      term = pty.spawn(msg.file, msg.args || [], {
        name: "xterm-256color",
        cols: msg.cols || 120,
        rows: msg.rows || 40,
        cwd: msg.cwd || process.cwd(),
        env: msg.env || process.env,
      });
      send({ ev: "spawned", pid: term.pid });
      term.onData((data) => {
        send({ ev: "data", data: Buffer.from(data, "utf8").toString("base64") });
      });
      term.onExit(({ exitCode, signal }) => {
        send({ ev: "exit", code: exitCode, signal: signal ?? null });
        setTimeout(() => process.exit(0), 10);
      });
    } else if (msg.op === "input") {
      if (term) term.write(msg.data);
    } else if (msg.op === "resize") {
      if (term) term.resize(msg.cols, msg.rows);
    } else if (msg.op === "kill") {
      if (term) {
        try { term.kill(msg.signal || "SIGKILL"); } catch {}
      }
    }
  } catch (err) {
    send({ ev: "error", message: String(err) });
  }
});

rl.on("close", () => {
  if (term) { try { term.kill("SIGKILL"); } catch {} }
  setTimeout(() => process.exit(0), 50);
});
