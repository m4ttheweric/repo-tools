import { describe, test, expect } from "bun:test";
import { withApiPortParkRetry, ApiPortInUseError } from "../api-server.ts";

describe("withApiPortParkRetry (S043 caller-side wiring)", () => {
  test("retries with backoff on ApiPortInUseError and returns once start succeeds", async () => {
    const sleeps: number[] = [];
    const warns: unknown[] = [];
    let attempts = 0;
    const result = await withApiPortParkRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new ApiPortInUseError(9401);
        return "server";
      },
      { sleep: async (ms) => { sleeps.push(ms); }, log: { warn: (o) => warns.push(o) } },
    );
    expect(result).toBe("server");
    expect(attempts).toBe(3);
    expect(sleeps.length).toBe(2);
    expect(warns.length).toBe(2);
  });

  test("backs off with an increasing delay on each successive attempt", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    await withApiPortParkRetry(
      async () => {
        attempts++;
        if (attempts < 4) throw new ApiPortInUseError(9401);
        return "server";
      },
      { sleep: async (ms) => { sleeps.push(ms); }, log: { warn: () => {} } },
    );
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]!);
    expect(sleeps[2]).toBeGreaterThan(sleeps[1]!);
  });

  test("a non-ApiPortInUseError error is never retried", async () => {
    let attempts = 0;
    await expect(
      withApiPortParkRetry(
        async () => { attempts++; throw new Error("state.db open failed"); },
        { sleep: async () => {}, log: { warn: () => {} } },
      ),
    ).rejects.toThrow("state.db open failed");
    expect(attempts).toBe(1);
  });
});
