import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { printAborted } from "../abort.ts";

/** Restores whatever isTTY/RT_BATCH looked like before the test touched them. */
function withStderrTTY(value: boolean, fn: () => void): void {
  const orig = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  Object.defineProperty(process.stderr, "isTTY", { value, configurable: true });
  try {
    fn();
  } finally {
    if (orig) Object.defineProperty(process.stderr, "isTTY", orig);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
  }
}

describe("printAborted", () => {
  const origBatch = process.env.RT_BATCH;

  afterEach(() => {
    if (origBatch === undefined) delete process.env.RT_BATCH;
    else process.env.RT_BATCH = origBatch;
  });

  test("writes one faint 'aborted' line to stderr when stderr is a TTY", () => {
    withStderrTTY(true, () => {
      delete process.env.RT_BATCH;
      const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        printAborted();
        expect(spy).toHaveBeenCalledTimes(1);
        const written = String(spy.mock.calls[0]![0]);
        expect(written).toContain("aborted");
      } finally {
        spy.mockRestore();
      }
    });
  });

  test("writes nothing when stderr is not a TTY", () => {
    withStderrTTY(false, () => {
      delete process.env.RT_BATCH;
      const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        printAborted();
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  test("writes nothing under RT_BATCH even on a TTY", () => {
    withStderrTTY(true, () => {
      process.env.RT_BATCH = "1";
      const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        printAborted();
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
