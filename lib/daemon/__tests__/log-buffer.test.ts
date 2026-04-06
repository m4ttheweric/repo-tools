/**
 * LogBuffer unit tests (19 tests)
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { LogBuffer } from "../log-buffer.ts";

let buf: LogBuffer;

beforeEach(() => {
  buf = new LogBuffer(100); // small max for overflow tests
});

// ── append / getLastLines ────────────────────────────────────────────────────

describe("append and getLastLines", () => {
  test("returns empty array for unknown id", () => {
    expect(buf.getLastLines("p1")).toEqual([]);
  });

  test("appends a single line", () => {
    buf.append("p1", "hello\n");
    expect(buf.getLastLines("p1")).toEqual(["hello"]);
  });

  test("appends multiple lines in one chunk", () => {
    buf.append("p1", "line1\nline2\nline3\n");
    expect(buf.getLastLines("p1")).toEqual(["line1", "line2", "line3"]);
  });

  test("handles partial line (no trailing newline)", () => {
    buf.append("p1", "partial");
    // Partial line is held pending — not yet complete
    expect(buf.getLastLines("p1")).toEqual([]);
  });

  test("partial line becomes complete when newline arrives", () => {
    buf.append("p1", "par");
    buf.append("p1", "tial\n");
    expect(buf.getLastLines("p1")).toEqual(["partial"]);
  });

  test("multiple separate appends accumulate correctly", () => {
    buf.append("p1", "a\n");
    buf.append("p1", "b\n");
    buf.append("p1", "c\n");
    expect(buf.getLastLines("p1")).toEqual(["a", "b", "c"]);
  });

  test("Uint8Array input works", () => {
    const data = new TextEncoder().encode("hello\nworld\n");
    buf.append("p1", data);
    expect(buf.getLastLines("p1")).toEqual(["hello", "world"]);
  });

  test("n parameter limits returned lines", () => {
    buf.append("p1", "a\nb\nc\nd\ne\n");
    expect(buf.getLastLines("p1", 3)).toEqual(["c", "d", "e"]);
  });

  test("n larger than buffer returns all", () => {
    buf.append("p1", "a\nb\n");
    expect(buf.getLastLines("p1", 100)).toEqual(["a", "b"]);
  });

  test("different process IDs are independent", () => {
    buf.append("p1", "for-p1\n");
    buf.append("p2", "for-p2\n");
    expect(buf.getLastLines("p1")).toEqual(["for-p1"]);
    expect(buf.getLastLines("p2")).toEqual(["for-p2"]);
  });
});

// ── Ring buffer overflow ─────────────────────────────────────────────────────

describe("ring buffer overflow", () => {
  test("drops oldest lines when max exceeded", () => {
    const small = new LogBuffer(3);
    small.append("p1", "a\nb\nc\nd\n");
    const lines = small.getLastLines("p1");
    expect(lines).toHaveLength(3);
    expect(lines).toEqual(["b", "c", "d"]);
  });

  test("overflow across multiple appends", () => {
    const small = new LogBuffer(2);
    small.append("p1", "line1\n");
    small.append("p1", "line2\n");
    small.append("p1", "line3\n");
    const lines = small.getLastLines("p1");
    expect(lines).toHaveLength(2);
    expect(lines).toContain("line3");
  });
});

// ── ANSI preservation ────────────────────────────────────────────────────────

describe("ANSI code preservation", () => {
  test("ANSI escape codes are preserved verbatim", () => {
    const colored = "\x1b[31mred text\x1b[0m";
    buf.append("p1", colored + "\n");
    expect(buf.getLastLines("p1")[0]).toBe(colored);
  });

  test("multi-part ANSI sequences across chunks are preserved", () => {
    buf.append("p1", "\x1b[1m");
    buf.append("p1", "bold\x1b[0m\n");
    expect(buf.getLastLines("p1")[0]).toBe("\x1b[1mbold\x1b[0m");
  });
});

// ── clear / remove ───────────────────────────────────────────────────────────

describe("clear and remove", () => {
  test("clear empties the buffer for an id", () => {
    buf.append("p1", "a\nb\n");
    buf.clear("p1");
    expect(buf.getLastLines("p1")).toEqual([]);
  });

  test("clear also discards pending partial line", () => {
    buf.append("p1", "incomplete");
    buf.clear("p1");
    buf.append("p1", "after-clear\n");
    expect(buf.getLastLines("p1")).toEqual(["after-clear"]);
  });

  test("clear does not affect other process IDs", () => {
    buf.append("p1", "p1-line\n");
    buf.append("p2", "p2-line\n");
    buf.clear("p1");
    expect(buf.getLastLines("p2")).toEqual(["p2-line"]);
  });

  test("remove works identically to clear", () => {
    buf.append("p1", "a\n");
    buf.remove("p1");
    expect(buf.getLastLines("p1")).toEqual([]);
  });
});
