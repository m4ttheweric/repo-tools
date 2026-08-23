import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRealProbes, readStdinJson } from "../probes.ts";
import { UserActionableError } from "../errors.ts";
import { fakeProbes } from "./fakes.ts";

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

describe("createRealProbes().fileSize", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-probes-filesize-"));

  test("a regular file sizes to its byte length", () => {
    const path = join(dir, "a-file");
    writeFileSync(path, "hello");
    expect(createRealProbes().fileSize(path)).toBe(5);
  });

  test("a directory is null, not its own size", () => {
    const path = join(dir, "a-dir");
    mkdirSync(path);
    expect(createRealProbes().fileSize(path)).toBeNull();
  });

  test("a symlink to a regular file sizes as the target", () => {
    const target = join(dir, "target-file");
    writeFileSync(target, "hi there");
    const link = join(dir, "link-to-file");
    symlinkSync(target, link);
    expect(createRealProbes().fileSize(link)).toBe(8);
  });

  test("a dangling symlink is null", () => {
    const link = join(dir, "dangling-link");
    symlinkSync(join(dir, "does-not-exist"), link);
    expect(createRealProbes().fileSize(link)).toBeNull();
  });

  test("a missing path is null", () => {
    expect(createRealProbes().fileSize(join(dir, "nope"))).toBeNull();
  });
});

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

  test("inherit:true hands the child the TTY and returns empty stdout/stderr", async () => {
    const probes = createRealProbes();
    const result = await probes.exec(["sh", "-c", "true"], { inherit: true });
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("a child that closes stdin before reading a large input resolves normally with no unhandled rejection", async () => {
    // Reviewer repro (Finding 1): FileSink.write/.end() return promises that
    // reject with EPIPE when the child never consumes stdin; unawaited, that
    // rejection used to escape the function entirely.
    const probes = createRealProbes();
    let unhandled: unknown = null;
    const onUnhandled = (err: unknown) => {
      unhandled = err;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const result = await probes.exec(["sh", "-c", "exit 0"], { input: "x".repeat(2_000_000) });
      expect(result.code).toBe(0);
      // Give a late rejection a tick to surface before asserting none did.
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toBeNull();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a SIGTERM-trapping child still resolves 124 within budget (escalates to SIGKILL)", async () => {
    // Reviewer repro (Finding 2, case 1): the timer used to call kill() with
    // no escalation, so a trapping child ran past the deadline forever.
    const probes = createRealProbes();
    const start = Date.now();
    const result = await probes.exec(["sh", "-c", "trap '' TERM; sleep 6"], { timeoutMs: 200 });
    expect(result.code).toBe(124);
    expect(Date.now() - start).toBeLessThan(1500);
  }, 3000);

  test("a grandchild holding the stdout pipe open still resolves 124 within budget", async () => {
    // Reviewer repro (Finding 2, case 2): the direct child dies but a
    // backgrounded grandchild keeps stdout's write end open, so an
    // unconditional `new Response(proc.stdout).text()` never resolved.
    const probes = createRealProbes();
    const start = Date.now();
    const result = await probes.exec(["sh", "-c", "sleep 6 & sleep 6"], { timeoutMs: 200 });
    expect(result.code).toBe(124);
    expect(Date.now() - start).toBeLessThan(1500);
  }, 3000);
});

describe("createRealProbes().fetch", () => {
  test("a connection failure resolves status 0 instead of throwing", async () => {
    const probes = createRealProbes();
    const result = await probes.fetch("http://127.0.0.1:1");
    expect(result.status).toBe(0);
  });

  test("response header names are lowercased", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok", { headers: { "X-Custom-Header": "value" } }) });
    try {
      const probes = createRealProbes();
      const result = await probes.fetch(`http://127.0.0.1:${server.port}/`);
      expect(result.status).toBe(200);
      expect(result.headers["x-custom-header"]).toBe("value");
    } finally {
      server.stop(true);
    }
  });
});

describe("createRealProbes().runRt", () => {
  test("spawns process.execPath with the given args and RT_SKIP_SETUP=1", async () => {
    const probes = createRealProbes();
    const result = await probes.runRt(["-e", "process.stdout.write(process.env.RT_SKIP_SETUP ?? 'unset')"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("1");
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

  test("calls.modes records the mode passed to writeFile and mkdirp", () => {
    const probes = fakeProbes();
    probes.writeFile("/a/file", "content", 0o600);
    probes.mkdirp("/a/dir", 0o700);
    expect(probes.calls.modes).toEqual({ "/a/file": 0o600, "/a/dir": 0o700 });
  });

  test("removeFile also removes a symlink at that path", () => {
    // The target must resolve to a tracked file — exists() follows links the
    // way real existsSync does, so a link to nothing (dangling) is exists:false.
    const probes = fakeProbes({ files: { "/target": "x" }, links: { "/link": "/target" } });
    expect(probes.exists("/link")).toBe(true);
    probes.removeFile("/link");
    expect(probes.exists("/link")).toBe(false);
  });

  test("removeDir recursively clears nested files/dirs/links", () => {
    const probes = fakeProbes({
      dirs: { "/root": ["child"], "/root/child": ["leaf"] },
      files: { "/root/child/leaf": "x" },
      links: { "/root/child/link": "/elsewhere" },
    });
    probes.removeDir("/root");
    expect(probes.readDir("/root")).toEqual([]);
    expect(probes.exists("/root/child")).toBe(false);
    expect(probes.readFile("/root/child/leaf")).toBeNull();
    expect(probes.readlink("/root/child/link")).toBeNull();
  });

  test("mkdirp registers the new dir in its parent's listing", () => {
    const probes = fakeProbes({ dirs: { "/root": [] } });
    probes.mkdirp("/root/child");
    expect(probes.readDir("/root")).toContain("child");
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
