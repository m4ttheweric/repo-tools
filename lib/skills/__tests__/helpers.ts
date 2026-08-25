import { spyOn } from "bun:test";

/**
 * Expected/domain errors print a clean one-liner and process.exit(1) instead
 * of throwing a bare stack trace (matches commands/secrets.ts,
 * commands/settings-keys.ts). Mock process.exit to throw a sentinel so the
 * real test process never dies, and read the spies' recorded calls BEFORE
 * mockRestore() -- bun's mockRestore() clears .mock.calls, unlike jest's.
 */
export async function runExpectingCleanExit(
  fn: () => Promise<void>,
): Promise<{ exitCode: number | undefined; errors: string[] }> {
  const errors: string[] = [];
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit sentinel");
  });
  const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  try {
    await fn();
    return { exitCode: undefined, errors };
  } catch {
    const exitCode = exitSpy.mock.calls.at(-1)?.[0] as number | undefined;
    return { exitCode, errors };
  } finally {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  }
}
