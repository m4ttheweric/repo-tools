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

process.stderr.write("fake-rt-ui: unknown verb\n");
process.exit(2);
