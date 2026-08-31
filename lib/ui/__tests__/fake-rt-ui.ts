#!/usr/bin/env bun
/**
 * A scripted rt-ui. RT_UI_FAKE carries JSON: { answer?, exit?, record?,
 * holdMs? }. Every stdin line is appended to `record` so tests can assert
 * the exact spec a call site sent. `holdMs` keeps the process alive before
 * answering so tests can observe stdin staying open.
 */
import { appendFileSync } from "fs";

const cfg = JSON.parse(process.env.RT_UI_FAKE ?? "{}") as {
  answer?: unknown;
  exit?: number;
  record?: string;
  holdMs?: number;
  dieOn?: "start";
  intents?: object[];
  closedReason?: string;
  protocol?: number;
};
const verb = process.argv[2];

const lines: string[] = [];
const decoder = new TextDecoder();
let buf = "";
const reader = Bun.stdin.stream().getReader();

async function drainUntil(count: number): Promise<void> {
  while (lines.length < count) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
}

if (verb === "prompt") {
  await drainUntil(1);
  if (cfg.record) appendFileSync(cfg.record, lines.join("\n") + "\n");
  if (cfg.holdMs) await Bun.sleep(cfg.holdMs);
  if (cfg.exit !== undefined) process.exit(cfg.exit);
  process.stdout.write(JSON.stringify({ t: "result", ...(cfg.answer as object) }) + "\n");
  process.exit(0);
}

if (verb === "steps") {
  // read until done/fail or EOF, record everything
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      lines.push(line);
      const t = (JSON.parse(line) as { t: string }).t;
      if (t === "start" && cfg.dieOn === "start") {
        if (cfg.record) appendFileSync(cfg.record, lines.join("\n") + "\n");
        process.exit(70);
      }
      if (t === "done" || t === "fail") {
        if (cfg.record) appendFileSync(cfg.record, lines.join("\n") + "\n");
        process.exit(cfg.exit ?? 0);
      }
    }
  }
  if (cfg.record) appendFileSync(cfg.record, lines.join("\n") + "\n");
  process.exit(cfg.exit ?? 0);
}

if (verb === "session") {
  const viewIdx = process.argv.indexOf("--view");
  const view = viewIdx >= 0 ? process.argv[viewIdx + 1] : "";
  process.stdout.write(JSON.stringify({ t: "hello", protocol: cfg.protocol ?? 1, version: "fake", views: [view] }) + "\n");
  const intents = (cfg.intents ?? []) as object[];
  let closedSent = false;
  const sendClosed = (reason: string) => {
    if (closedSent) return;
    closedSent = true;
    process.stdout.write(JSON.stringify({ t: "closed", reason }) + "\n");
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      if (cfg.record) appendFileSync(cfg.record, lines.join("\n") + "\n");
      sendClosed("error");
      process.exit(70);
    }
    buf += decoder.decode(value);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      lines.push(line);
      const t = (JSON.parse(line) as { t: string }).t;
      if (t === "open") {
        if (cfg.exit !== undefined) {
          if (cfg.record) appendFileSync(cfg.record, lines.join("\n") + "\n");
          process.exit(cfg.exit);
        }
        for (const it of intents) {
          await Bun.sleep(20);
          process.stdout.write(JSON.stringify({ t: "intent", ...it }) + "\n");
          if ((it as { name?: string }).name === "quit") {
            if (cfg.record) appendFileSync(cfg.record, lines.join("\n") + "\n");
            sendClosed("quit");
            process.exit(0);
          }
        }
      }
      if (t === "close") {
        if (cfg.record) appendFileSync(cfg.record, lines.join("\n") + "\n");
        sendClosed((cfg.closedReason as string | undefined) ?? "closed");
        process.exit(0);
      }
    }
  }
}

process.stderr.write("fake-rt-ui: unknown verb\n");
process.exit(2);
