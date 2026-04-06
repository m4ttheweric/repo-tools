/**
 * LogBuffer — per-process circular ring buffer for PTY output.
 *
 * Stores the last N lines of output for each process ID, preserving ANSI
 * escape codes. Used by AttachServer to replay history on client connect.
 *
 * Lines are split on '\n'. Partial lines (no trailing newline) are held in
 * a pending buffer until a newline arrives.
 */

const DEFAULT_MAX_LINES = 5000;

export class LogBuffer {
  private buffers = new Map<string, string[]>();
  private pending = new Map<string, string>(); // incomplete last line per process
  private maxLines: number;

  constructor(maxLines = DEFAULT_MAX_LINES) {
    this.maxLines = maxLines;
  }

  /** Append raw PTY data (may be string or Uint8Array). Splits on newlines. */
  append(id: string, data: string | Uint8Array): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);

    let buf = this.buffers.get(id);
    if (!buf) {
      buf = [];
      this.buffers.set(id, buf);
    }

    const carry = this.pending.get(id) ?? "";
    const combined = carry + text;
    const parts = combined.split("\n");

    // Everything except the last element is a complete line.
    // The last element is the new pending (may be empty string if text ended with \n).
    const complete = parts.slice(0, -1);
    const newPending = parts[parts.length - 1]!;

    this.pending.set(id, newPending);

    for (const line of complete) {
      buf.push(line);
      // Ring buffer: drop oldest if over limit
      if (buf.length > this.maxLines) buf.shift();
    }
  }

  /**
   * Return the last `n` complete lines for a process.
   * If `n` is omitted, returns all stored lines.
   * Does not include any pending (incomplete) last line.
   */
  getLastLines(id: string, n?: number): string[] {
    const buf = this.buffers.get(id) ?? [];
    return n === undefined ? buf.slice() : buf.slice(-n);
  }

  /** Clear all buffered output for a process (called at start of each spawn). */
  clear(id: string): void {
    this.buffers.delete(id);
    this.pending.delete(id);
  }

  /** Remove all state for a process (called when entry is fully deleted). */
  remove(id: string): void {
    this.clear(id);
  }
}
