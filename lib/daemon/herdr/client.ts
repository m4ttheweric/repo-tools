import { homedir } from "os";
import { join } from "path";
import { encodeRequest, parseLine } from "./protocol.ts";

export interface HerdrTransport { request(line: string): Promise<string> }

function defaultSocketPath(): string {
  return process.env.HERDR_SOCKET_PATH || join(homedir(), ".config", "herdr", "herdr.sock");
}

/** One short-lived unix-socket round trip per call (reads are low-frequency). */
class UnixSocketTransport implements HerdrTransport {
  constructor(private socketPath: string) {}
  async request(line: string): Promise<string> {
    let buf = "";
    let resolve!: (s: string) => void;
    let reject!: (e: unknown) => void;
    const done = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    const sock = await Bun.connect({
      unix: this.socketPath,
      socket: {
        open(s) { s.write(line); },
        data(_s, d) {
          buf += new TextDecoder().decode(d);
          const nl = buf.indexOf("\n");
          if (nl >= 0) resolve(buf.slice(0, nl));
        },
        error(_s, e) { reject(e); },
        close() { if (!buf.includes("\n")) reject(new Error("herdr socket closed")); },
      },
    });
    try { return await done; } finally { try { sock.end(); } catch { /* */ } }
  }
}

export class HerdrClient {
  private transport: HerdrTransport;
  private seq = 0;
  constructor(deps?: { transport?: HerdrTransport; socketPath?: string }) {
    this.transport = deps?.transport ?? new UnixSocketTransport(deps?.socketPath ?? defaultSocketPath());
  }
  async call(method: string, params?: unknown): Promise<any> {
    const id = `rt:${this.seq++}`;
    const respLine = await this.transport.request(encodeRequest({ id, method, params: params ?? {} }));
    const resp = parseLine(respLine);
    if (!resp) throw new Error(`herdr: unparseable response to ${method}`);
    if (resp.error) throw new Error(resp.error.message || resp.error.code);
    return resp.result;
  }
  async available(): Promise<boolean> {
    try { await this.call("ping"); return true; } catch { return false; }
  }
}
