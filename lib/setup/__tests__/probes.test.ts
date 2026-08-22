import { describe, test, expect } from "bun:test";
import { createRealProbes, readStdinJson } from "../probes.ts";
import { UserActionableError } from "../errors.ts";
import { fakeProbes } from "./fakes.ts";

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

describe("createRealProbes().exec", () => {
  test("a missing binary resolves code 127 instead of throwing", async () => {
    const probes = createRealProbes();
    const result = await probes.exec(["/nonexistent/bin"]);
    expect(result.code).toBe(127);
  });

  test("runs a real command and captures stdout", async () => {
    const probes = createRealProbes();
    const result = await probes.exec(["sh", "-c", "echo hi"]);
    expect(result).toEqual({ code: 0, stdout: "hi\n", stderr: "" });
  });

  test("a command exceeding timeoutMs is killed and reports code 124", async () => {
    const probes = createRealProbes();
    const result = await probes.exec(["sh", "-c", "sleep 5"], { timeoutMs: 100 });
    expect(result.code).toBe(124);
  }, 2000);
});

describe("createRealProbes().fetch", () => {
  test("a connection failure resolves status 0 instead of throwing", async () => {
    const probes = createRealProbes();
    const result = await probes.fetch("http://127.0.0.1:1");
    expect(result.status).toBe(0);
  });
});

describe("fakeProbes", () => {
  test("readFile returns seeded content; exists is false for unseeded paths", () => {
    const probes = fakeProbes({ files: { "/a": "x" } });
    expect(probes.readFile("/a")).toBe("x");
    expect(probes.exists("/b")).toBe(false);
  });

  test("calls.exec records every exec argv", async () => {
    const probes = fakeProbes();
    await probes.exec(["echo", "hi"]);
    await probes.exec(["ls", "-la"]);
    expect(probes.calls.exec).toEqual([["echo", "hi"], ["ls", "-la"]]);
  });
});

describe("readStdinJson", () => {
  test("parses valid JSON from stdin", async () => {
    const result = await readStdinJson(streamFrom('{"a":1}'));
    expect(result).toEqual({ a: 1 });
  });

  test("returns null on empty stdin", async () => {
    const result = await readStdinJson(streamFrom(""));
    expect(result).toBeNull();
  });

  test("throws UserActionableError('bad-stdin') on malformed JSON", async () => {
    await expect(readStdinJson(streamFrom("not json"))).rejects.toThrow(UserActionableError);
    try {
      await readStdinJson(streamFrom("not json"));
      throw new Error("expected readStdinJson to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UserActionableError);
      expect((err as UserActionableError).code).toBe("bad-stdin");
    }
  });
});
