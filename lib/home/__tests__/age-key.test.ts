import { describe, test, expect, spyOn } from "bun:test";
import * as fs from "fs";
import {
  ensureAgeKey,
  readAgeKey,
  renderSopsYaml,
  keyExport,
  withArgvRedaction,
  type AgeExecResult,
  type AgeKeySeam,
} from "../age-key.ts";

const FIND_CMD = ["security", "find-generic-password", "-a", "mattstack", "-s", "mattstack-age-key", "-w"];
const ADD_CMD_PREFIX = ["security", "add-generic-password", "-a", "mattstack", "-s", "mattstack-age-key", "-w"];

const FAKE_PUBLIC_KEY = "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const FAKE_PRIVATE_KEY = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";
const FAKE_KEYGEN_STDOUT = `# created: 2024-01-01T00:00:00Z\n# public key: ${FAKE_PUBLIC_KEY}\n${FAKE_PRIVATE_KEY}\n`;

type Call = { cmd: string[]; opts?: { input?: string; sensitive?: boolean } };

/** Stateful enough to model the real keychain: a successful add-generic-password
 * makes the next find-generic-password see the newly stored key. */
class FakeAgeKeySeam implements AgeKeySeam {
  calls: Call[] = [];
  private storedKey: string | undefined;

  constructor(
    private opts: {
      find?: { code: number; stdout: string };
      keygen?: { code: number; stdout: string };
      deriveY?: { code: number; stdout: string };
      addPassword?: { code: number };
    } = {},
  ) {
    if (this.opts.find?.code === 0) this.storedKey = this.opts.find.stdout.trim();
  }

  async run(cmd: string[], runOpts?: { input?: string; sensitive?: boolean }): Promise<AgeExecResult> {
    this.calls.push({ cmd, opts: runOpts });

    if (cmd[0] === "security" && cmd[1] === "find-generic-password") {
      if (this.storedKey) return { code: 0, stdout: `${this.storedKey}\n`, stderr: "" };
      const r = this.opts.find ?? { code: 1, stdout: "" };
      return { code: r.code, stdout: r.stdout, stderr: r.code === 0 ? "" : "security: could not be found" };
    }
    if (cmd[0] === "age-keygen" && cmd[1] === "-y") {
      const r = this.opts.deriveY ?? { code: 0, stdout: `${FAKE_PUBLIC_KEY}\n` };
      return { code: r.code, stdout: r.stdout, stderr: "" };
    }
    if (cmd[0] === "age-keygen") {
      const r = this.opts.keygen ?? { code: 0, stdout: FAKE_KEYGEN_STDOUT };
      return { code: r.code, stdout: r.stdout, stderr: "" };
    }
    if (cmd[0] === "security" && cmd[1] === "add-generic-password") {
      const r = this.opts.addPassword ?? { code: 0 };
      if (r.code === 0) this.storedKey = cmd.at(-2);
      return { code: r.code, stdout: "", stderr: r.code === 0 ? "" : "security: write failed" };
    }

    throw new Error(`FakeAgeKeySeam: unexpected call ${cmd.join(" ")}`);
  }
}

describe("readAgeKey", () => {
  test("keychain find succeeds -> returns the trimmed private key", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 0, stdout: `${FAKE_PRIVATE_KEY}\n` } });
    const key = await readAgeKey(seam);
    expect(key).toBe(FAKE_PRIVATE_KEY);
    expect(seam.calls).toEqual([{ cmd: FIND_CMD, opts: { sensitive: true } }]);
  });

  test("keychain find fails (no entry yet) -> returns null", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 44, stdout: "" } });
    const key = await readAgeKey(seam);
    expect(key).toBeNull();
  });
});

describe("ensureAgeKey", () => {
  test("no existing key: generates via age-keygen, stores the private key in the keychain, returns the public key", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 44, stdout: "" } });

    const result = await ensureAgeKey(seam);

    expect(result).toEqual({ publicKey: FAKE_PUBLIC_KEY });
    expect(seam.calls.map((c) => c.cmd)).toEqual([FIND_CMD, ["age-keygen"], [...ADD_CMD_PREFIX, FAKE_PRIVATE_KEY, "-U"]]);
  });

  test("no existing key: the keychain-write call carries the private key ONLY as its argv value, marked sensitive", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 44, stdout: "" } });

    await ensureAgeKey(seam);

    const addCall = seam.calls.find((c) => c.cmd[1] === "add-generic-password");
    expect(addCall?.opts?.sensitive).toBe(true);
    expect(addCall?.cmd.at(-2)).toBe(FAKE_PRIVATE_KEY);
  });

  test("existing key in the keychain: derives the public key via age-keygen -y, never generates a new key, never writes the keychain again", async () => {
    const seam = new FakeAgeKeySeam({
      find: { code: 0, stdout: `${FAKE_PRIVATE_KEY}\n` },
      deriveY: { code: 0, stdout: `${FAKE_PUBLIC_KEY}\n` },
    });

    const result = await ensureAgeKey(seam);

    expect(result).toEqual({ publicKey: FAKE_PUBLIC_KEY });
    expect(seam.calls.map((c) => c.cmd)).toEqual([FIND_CMD, ["age-keygen", "-y"]]);
    // The private key is piped via stdin, never argv.
    const deriveCall = seam.calls.find((c) => c.cmd[0] === "age-keygen" && c.cmd[1] === "-y");
    expect(deriveCall?.opts?.input).toBe(FAKE_PRIVATE_KEY);
    expect(deriveCall?.cmd).not.toContain(FAKE_PRIVATE_KEY);
  });
});

describe("withArgvRedaction", () => {
  test("the add-generic-password call's -w value is redacted before it reaches the log, never in the clear", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 44, stdout: "" } });
    const logged: string[][] = [];
    const wrapped = withArgvRedaction(seam, (cmd) => logged.push(cmd));

    await ensureAgeKey(wrapped);

    const loggedAddCall = logged.find((cmd) => cmd.includes("add-generic-password"));
    expect(loggedAddCall).toBeDefined();
    expect(loggedAddCall).toContain("<redacted>");
    expect(logged.flat()).not.toContain(FAKE_PRIVATE_KEY);

    // The underlying seam still receives the real, unredacted key.
    const realAddCall = seam.calls.find((c) => c.cmd.includes("add-generic-password"));
    expect(realAddCall?.cmd.at(-2)).toBe(FAKE_PRIVATE_KEY);
  });

  test("non-sensitive calls pass through the log unredacted", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 0, stdout: `${FAKE_PRIVATE_KEY}\n` } });
    const logged: string[][] = [];
    const wrapped = withArgvRedaction(seam, (cmd) => logged.push(cmd));

    await readAgeKey(wrapped);

    // find's argv carries no secret value, so redaction is a no-op here —
    // only the -w VALUE (not the -w flag itself) is ever a redaction target.
    expect(logged).toEqual([FIND_CMD]);
  });
});

describe("renderSopsYaml", () => {
  test("emits a creation rule encrypting user/secrets/** to the given recipient", () => {
    const yaml = renderSopsYaml("age1xyz");
    expect(yaml).toContain("path_regex: user/secrets/.*");
    expect(yaml).toContain("age1xyz");
  });
});

describe("keyExport", () => {
  test("existing key: prints it exactly once with a warning header, never regenerates, never touches the fs", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 0, stdout: `${FAKE_PRIVATE_KEY}\n` } });
    const printed: string[] = [];
    const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("keyExport must never write a file");
    });

    try {
      await keyExport(seam, (text) => printed.push(text));
    } finally {
      writeSpy.mockRestore();
    }

    expect(printed.length).toBe(1);
    expect(printed[0]).toContain(FAKE_PRIVATE_KEY);
    expect(printed[0]).toMatch(/warning/i);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(seam.calls.some((c) => c.cmd.includes("add-generic-password"))).toBe(false);
  });

  test("no key yet: mints one via ensureAgeKey, then prints it exactly once, still never touching the fs", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 44, stdout: "" } });
    const printed: string[] = [];
    const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("keyExport must never write a file");
    });

    try {
      await keyExport(seam, (text) => printed.push(text));
    } finally {
      writeSpy.mockRestore();
    }

    expect(printed.length).toBe(1);
    expect(printed[0]).toContain(FAKE_PRIVATE_KEY);
    expect(printed[0]).toMatch(/warning/i);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(seam.calls.some((c) => c.cmd.includes("add-generic-password"))).toBe(true);
  });
});
