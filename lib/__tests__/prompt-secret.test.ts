import { describe, test, expect } from "bun:test";
import { EventEmitter } from "events";
import { promptSecret, type PromptIO, type PromptStdin } from "../prompt-secret.ts";

const DEL = "\u007f";
const CTRL_C = "\u0003";

/** Drives promptSecret's `data` handler synthetically — never a real TTY. */
class FakeStdin extends EventEmitter implements PromptStdin {
  isTTY = true;
  rawModeCalls: boolean[] = [];
  resumed = false;
  paused = false;

  setRawMode(mode: boolean): void {
    this.rawModeCalls.push(mode);
  }
  resume(): void {
    this.resumed = true;
  }
  pause(): void {
    this.paused = true;
  }
}

function fakeIO(stdin: FakeStdin): { io: PromptIO; written: string[] } {
  const written: string[] = [];
  return { io: { stdin, write: (text) => written.push(text) }, written };
}

describe("promptSecret", () => {
  test("not a TTY: rejects, pointing at --stdin, and never enters raw mode", async () => {
    const stdin = new FakeStdin();
    stdin.isTTY = false;
    const { io } = fakeIO(stdin);

    await expect(promptSecret("Value", io)).rejects.toThrow(/not a TTY.*--stdin/);
    expect(stdin.rawModeCalls).toEqual([]);
  });

  test("resolves with the typed characters on Enter, never echoing them to the write sink", async () => {
    const stdin = new FakeStdin();
    const { io, written } = fakeIO(stdin);

    const pending = promptSecret("Value", io);
    stdin.emit("data", Buffer.from("hunter2"));
    stdin.emit("data", Buffer.from("\n"));

    await expect(pending).resolves.toBe("hunter2");
    expect(written.join("")).not.toContain("hunter2");
    expect(stdin.rawModeCalls).toEqual([true, false]);
  });

  test("carriage return (\\r) also terminates, same as \\n", async () => {
    const stdin = new FakeStdin();
    const { io } = fakeIO(stdin);

    const pending = promptSecret("Value", io);
    stdin.emit("data", Buffer.from("abc"));
    stdin.emit("data", Buffer.from("\r"));

    await expect(pending).resolves.toBe("abc");
  });

  test("DEL (backspace) removes the previously typed character", async () => {
    const stdin = new FakeStdin();
    const { io } = fakeIO(stdin);

    const pending = promptSecret("Value", io);
    stdin.emit("data", Buffer.from("abcx"));
    stdin.emit("data", Buffer.from(DEL));
    stdin.emit("data", Buffer.from("\n"));

    await expect(pending).resolves.toBe("abc");
  });

  test("Ctrl-C rejects as cancelled and still restores raw mode (cleanup runs on every exit path)", async () => {
    const stdin = new FakeStdin();
    const { io } = fakeIO(stdin);

    const pending = promptSecret("Value", io);
    stdin.emit("data", Buffer.from("partial"));
    stdin.emit("data", Buffer.from(CTRL_C));

    await expect(pending).rejects.toThrow(/cancelled/);
    expect(stdin.rawModeCalls).toEqual([true, false]);
  });

  test("writes the prompt message once, before any input arrives", async () => {
    const stdin = new FakeStdin();
    const { io, written } = fakeIO(stdin);

    const pending = promptSecret("Paste the age private key", io);
    expect(written).toEqual(["Paste the age private key: "]);
    stdin.emit("data", Buffer.from("\n"));
    await pending;
  });
});
