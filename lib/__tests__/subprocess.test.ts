import { describe, test, expect, afterEach } from "bun:test";
import { runCapture, outputTail, MAX_LOGGED_OUTPUT } from "../subprocess.ts";

const SENTINEL = "RT_SPAWN_ENV_SENTINEL";

describe("runCapture env", () => {
  afterEach(() => {
    delete process.env[SENTINEL];
  });

  test("children see values assigned to process.env after startup", async () => {
    process.env[SENTINEL] = "visible";

    const r = await runCapture(["/bin/sh", "-c", `printf %s "$${SENTINEL}"`]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("visible");
  });

  test("an explicit env replaces the inherited one", async () => {
    process.env[SENTINEL] = "inherited";

    const r = await runCapture(["/bin/sh", "-c", `printf %s "$${SENTINEL}"`], {
      env: { [SENTINEL]: "explicit" },
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("explicit");
  });
});

describe("outputTail", () => {
  test("passes short output through, trimmed", () => {
    expect(outputTail("  env: node: No such file or directory\n", 2000))
      .toBe("env: node: No such file or directory");
  });

  test("keeps the tail, not the head, and marks the elision", () => {
    const output = `${"x".repeat(50)}THE-REAL-ERROR`;

    const tail = outputTail(output, 20);

    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("THE-REAL-ERROR")).toBe(true);
    expect(tail.length).toBe(21);
  });

  test("MAX_LOGGED_OUTPUT is the shared cap", () => {
    expect(MAX_LOGGED_OUTPUT).toBe(2000);
  });
});
