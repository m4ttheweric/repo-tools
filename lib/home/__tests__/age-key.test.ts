import { describe, test, expect, spyOn } from "bun:test";
import * as fs from "fs";
import {
  ensureAgeKey,
  importAgeKey,
  readAgeKey,
  renderSopsYaml,
  renderSopsYamlFor,
  keyExport,
  withArgvRedaction,
  AgeKeyAbsentError,
  AgeKeyTimeoutError,
  createRealAgeKeySeam,
  type AgeExecResult,
  type AgeKeySeam,
} from "../age-key.ts";

/** Matches `fs`, `node:fs`, `fs/promises`, and `node:fs/promises` — every spelling age-key.ts must never import. */
const FS_IMPORT_RE = /from\s+["'](?:node:)?fs(?:\/promises)?["']|require\(["'](?:node:)?fs(?:\/promises)?["']\)/;

const FIND_CMD = ["security", "find-generic-password", "-a", "mattstack", "-s", "mattstack-age-key", "-w"];
const ADD_CMD_PREFIX = ["security", "add-generic-password", "-a", "mattstack", "-s", "mattstack-age-key", "-w"];
const NOT_FOUND_STDERR = "The specified item could not be found in the keychain.";

const FAKE_PUBLIC_KEY = "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const FAKE_PRIVATE_KEY = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";
const FAKE_KEYGEN_STDOUT = `# created: 2024-01-01T00:00:00Z\n# public key: ${FAKE_PUBLIC_KEY}\n${FAKE_PRIVATE_KEY}\n`;

type Call = { cmd: string[]; opts?: { input?: string; sensitive?: boolean } };

/**
 * Stateful enough to model the real keychain: a successful add-generic-password
 * makes the next find-generic-password see the newly stored key. `find.code
 * === 44` without an explicit stderr is auto-corroborated with the real
 * "could not be found" marker text, so most tests don't need to spell it
 * out; pass an explicit non-matching stderr to model the ambiguous cases.
 */
class FakeAgeKeySeam implements AgeKeySeam {
  calls: Call[] = [];
  private storedKey: string | undefined;

  constructor(
    private opts: {
      find?: { code: number; stdout: string; stderr?: string };
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
      const r = this.opts.find ?? { code: 44, stdout: "", stderr: NOT_FOUND_STDERR };
      const stderr = r.stderr ?? (r.code === 44 ? NOT_FOUND_STDERR : "");
      return { code: r.code, stdout: r.stdout, stderr };
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
      if (r.code === 0) this.storedKey = cmd.at(-1);
      return { code: r.code, stdout: "", stderr: r.code === 0 ? "" : "security: write failed" };
    }

    throw new Error(`FakeAgeKeySeam: unexpected call ${cmd.join(" ")}`);
  }
}

describe("readAgeKey", () => {
  test("keychain find succeeds -> returns {key}", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 0, stdout: `${FAKE_PRIVATE_KEY}\n` } });
    const result = await readAgeKey(seam);
    expect(result).toEqual({ key: FAKE_PRIVATE_KEY });
    expect(seam.calls).toEqual([{ cmd: FIND_CMD, opts: { sensitive: true } }]);
  });

  test("provable absence (exit 44 + the 'could not be found' marker) -> {absent: true}", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 44, stdout: "", stderr: NOT_FOUND_STDERR } });
    const result = await readAgeKey(seam);
    expect(result).toEqual({ absent: true });
  });

  test("exit 44 WITHOUT the corroborating stderr marker -> throws, not treated as absent", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 44, stdout: "", stderr: "some unrelated security error" } });
    await expect(readAgeKey(seam)).rejects.toThrow(/keychain unreachable/i);
  });

  test("exit 36 (locked keychain) -> throws instead of silently reporting absent", async () => {
    const seam = new FakeAgeKeySeam({
      find: { code: 36, stdout: "", stderr: "SecKeychainItemCopyContent: the user name or passphrase is not correct" },
    });
    await expect(readAgeKey(seam)).rejects.toThrow(/keychain unreachable/i);
  });

  test("exit 128 (access-control dialog denied) -> throws instead of silently reporting absent", async () => {
    const seam = new FakeAgeKeySeam({
      find: { code: 128, stdout: "", stderr: "SecKeychainFindGenericPassword: user interaction is not allowed" },
    });
    await expect(readAgeKey(seam)).rejects.toThrow(/keychain unreachable/i);
  });
});

describe("ensureAgeKey", () => {
  test("provable absence: generates via age-keygen, stores the private key with NO -U (no overwrite flag), returns the public key", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 44, stdout: "" } });

    const result = await ensureAgeKey(seam);

    expect(result).toEqual({ publicKey: FAKE_PUBLIC_KEY, minted: true });
    expect(seam.calls.map((c) => c.cmd)).toEqual([FIND_CMD, ["age-keygen"], [...ADD_CMD_PREFIX, FAKE_PRIVATE_KEY]]);
  });

  test("provable absence: the keychain-write call carries the private key ONLY as its argv value, marked sensitive", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 44, stdout: "" } });

    await ensureAgeKey(seam);

    const addCall = seam.calls.find((c) => c.cmd[1] === "add-generic-password");
    expect(addCall?.opts?.sensitive).toBe(true);
    expect(addCall?.cmd.at(-1)).toBe(FAKE_PRIVATE_KEY);
    expect(addCall?.cmd).not.toContain("-U");
  });

  test("existing key: derives the public key via age-keygen -y, never generates a new key, never writes the keychain again", async () => {
    const seam = new FakeAgeKeySeam({
      find: { code: 0, stdout: `${FAKE_PRIVATE_KEY}\n` },
      deriveY: { code: 0, stdout: `${FAKE_PUBLIC_KEY}\n` },
    });

    const result = await ensureAgeKey(seam);

    expect(result).toEqual({ publicKey: FAKE_PUBLIC_KEY, minted: false });
    expect(seam.calls.map((c) => c.cmd)).toEqual([FIND_CMD, ["age-keygen", "-y"]]);
    // The private key is piped via stdin, never argv.
    const deriveCall = seam.calls.find((c) => c.cmd[0] === "age-keygen" && c.cmd[1] === "-y");
    expect(deriveCall?.opts?.input).toBe(FAKE_PRIVATE_KEY);
    expect(deriveCall?.cmd).not.toContain(FAKE_PRIVATE_KEY);
  });

  describe("keychain-access errors never trigger a mint (the catastrophe this design exists to prevent)", () => {
    test("find exits 36 (locked keychain): throws, and mints/writes nothing", async () => {
      const seam = new FakeAgeKeySeam({
        find: { code: 36, stdout: "", stderr: "SecKeychainItemCopyContent: the user name or passphrase is not correct" },
      });

      await expect(ensureAgeKey(seam)).rejects.toThrow(/keychain unreachable/i);

      expect(seam.calls.map((c) => c.cmd)).toEqual([FIND_CMD]);
      expect(seam.calls.some((c) => c.cmd[0] === "age-keygen")).toBe(false);
      expect(seam.calls.some((c) => c.cmd.includes("add-generic-password"))).toBe(false);
    });

    test("find exits 128 (access-control dialog denied): throws, and mints/writes nothing", async () => {
      const seam = new FakeAgeKeySeam({
        find: { code: 128, stdout: "", stderr: "SecKeychainFindGenericPassword: user interaction is not allowed" },
      });

      await expect(ensureAgeKey(seam)).rejects.toThrow(/keychain unreachable/i);

      expect(seam.calls.map((c) => c.cmd)).toEqual([FIND_CMD]);
      expect(seam.calls.some((c) => c.cmd[0] === "age-keygen")).toBe(false);
      expect(seam.calls.some((c) => c.cmd.includes("add-generic-password"))).toBe(false);
    });
  });
});

describe("importAgeKey", () => {
  const OTHER_PUBLIC_KEY = "age1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
  const OTHER_PRIVATE_KEY = "AGE-SECRET-KEY-1ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";

  test("no existing key: derives the public key via age-keygen -y, stores WITHOUT -U, returns {ok: true, publicKey}", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 44, stdout: "" } });

    const result = await importAgeKey(seam, FAKE_PRIVATE_KEY);

    expect(result).toEqual({ ok: true, publicKey: FAKE_PUBLIC_KEY });
    const addCall = seam.calls.find((c) => c.cmd[1] === "add-generic-password");
    expect(addCall?.cmd).toEqual([...ADD_CMD_PREFIX, FAKE_PRIVATE_KEY]);
    expect(addCall?.cmd).not.toContain("-U");
  });

  test("malformed value (wrong prefix): refused before any seam call", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 44, stdout: "" } });

    const result = await importAgeKey(seam, "not-an-age-key");

    expect(result).toEqual({ ok: false, reason: "malformed" });
    expect(seam.calls).toEqual([]);
  });

  test("right prefix but age-keygen -y rejects it: refused as malformed", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 44, stdout: "" }, deriveY: { code: 1, stdout: "" } });

    const result = await importAgeKey(seam, FAKE_PRIVATE_KEY);

    expect(result).toEqual({ ok: false, reason: "malformed" });
    expect(seam.calls.some((c) => c.cmd.includes("add-generic-password"))).toBe(false);
  });

  test("a key already exists, no --force: refused with the existing recipient, never overwrites", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 0, stdout: `${OTHER_PRIVATE_KEY}\n` } });
    // age-keygen -y is called twice (new key, then existing key) — give distinct answers by call order.
    let call = 0;
    const origRun = seam.run.bind(seam);
    seam.run = async (cmd, opts) => {
      if (cmd[0] === "age-keygen" && cmd[1] === "-y") {
        call++;
        return call === 1 ? { code: 0, stdout: `${FAKE_PUBLIC_KEY}\n`, stderr: "" } : { code: 0, stdout: `${OTHER_PUBLIC_KEY}\n`, stderr: "" };
      }
      return origRun(cmd, opts);
    };

    const result = await importAgeKey(seam, FAKE_PRIVATE_KEY);

    expect(result).toEqual({ ok: false, reason: "exists", existingPublicKey: OTHER_PUBLIC_KEY });
    expect(seam.calls.some((c) => c.cmd.includes("add-generic-password"))).toBe(false);
  });

  test("a key already exists, --force: overwrites via -U, returns the new public key", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 0, stdout: `${OTHER_PRIVATE_KEY}\n` } });

    const result = await importAgeKey(seam, FAKE_PRIVATE_KEY, { force: true });

    expect(result).toEqual({ ok: true, publicKey: FAKE_PUBLIC_KEY });
    const addCall = seam.calls.find((c) => c.cmd[1] === "add-generic-password");
    expect(addCall?.cmd).toContain("-U");
    expect(addCall?.cmd.at(-1)).toBe(FAKE_PRIVATE_KEY);
    // --force skips the existing-key lookup entirely — no read-before-write race.
    expect(seam.calls.some((c) => c.cmd[1] === "find-generic-password")).toBe(false);
  });

  test("no existing key: the exact call sequence is derive-new, find, store — nothing else", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 44, stdout: "" } });

    await importAgeKey(seam, FAKE_PRIVATE_KEY);

    expect(seam.calls.map((c) => c.cmd)).toEqual([
      ["age-keygen", "-y"],
      FIND_CMD,
      [...ADD_CMD_PREFIX, FAKE_PRIVATE_KEY],
    ]);
  });

  test("non-force path: readAgeKey throwing (locked keychain) propagates, and nothing is ever stored", async () => {
    const seam = new FakeAgeKeySeam({
      find: { code: 36, stdout: "", stderr: "SecKeychainItemCopyContent: the user name or passphrase is not correct" },
    });

    await expect(importAgeKey(seam, FAKE_PRIVATE_KEY)).rejects.toThrow(/keychain unreachable/i);

    expect(seam.calls.some((c) => c.cmd.includes("add-generic-password"))).toBe(false);
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
    expect(realAddCall?.cmd.at(-1)).toBe(FAKE_PRIVATE_KEY);
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
  test("emits a creation rule encrypting secrets/** (cwd-relative, cwd pinned to <mattstackHome>/user) to the given recipient", () => {
    const yaml = renderSopsYaml("age1xyz");
    expect(yaml).toContain("path_regex: secrets/.*");
    expect(yaml).toContain("age1xyz");
  });
});

describe("renderSopsYamlFor", () => {
  test("emits a creation rule matching the given path_regex, one comma-separated age: value for every recipient", () => {
    const yaml = renderSopsYamlFor("mattstack/secrets/.*", ["age1aaa", "age1bbb"]);
    expect(yaml).toContain("path_regex: mattstack/secrets/.*");
    expect(yaml).toContain("age: age1aaa,age1bbb");
  });

  test("renderSopsYaml is the single-recipient special case of this", () => {
    expect(renderSopsYaml("age1xyz")).toBe(renderSopsYamlFor("secrets/.*", ["age1xyz"]));
  });
});

describe("keyExport", () => {
  test("existing key: reads it with exactly one find call, prints it exactly once with a warning header, never touches the fs", async () => {
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
    expect(printed[0]).not.toMatch(/print it again/i); // the header must not claim a false guarantee
    expect(writeSpy).not.toHaveBeenCalled();
    expect(seam.calls).toEqual([{ cmd: FIND_CMD, opts: { sensitive: true } }]);
  });

  test("no key yet (provably absent): refuses without minting, points at `rt home init`, prints nothing, never touches the fs", async () => {
    const seam = new FakeAgeKeySeam({ find: { code: 44, stdout: "" } });
    const printed: string[] = [];
    const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("keyExport must never write a file");
    });

    let thrown: unknown;
    try {
      await keyExport(seam, (text) => printed.push(text));
    } catch (err) {
      thrown = err;
    } finally {
      writeSpy.mockRestore();
    }

    expect(thrown).toBeInstanceOf(AgeKeyAbsentError);
    expect((thrown as Error).message).toMatch(/rt home init/);
    expect(printed).toEqual([]);
    expect(writeSpy).not.toHaveBeenCalled();
    // Export never mints — only the one failed lookup, nothing else.
    expect(seam.calls).toEqual([{ cmd: FIND_CMD, opts: { sensitive: true } }]);
    expect(seam.calls.some((c) => c.cmd[0] === "age-keygen")).toBe(false);
    expect(seam.calls.some((c) => c.cmd.includes("add-generic-password"))).toBe(false);
  });

  test("the module has zero fs imports — the no-file guarantee is structural, not just runtime-observed", () => {
    const source = fs.readFileSync(new URL("../age-key.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(FS_IMPORT_RE);
  });

  test("the fs-import guard also catches node:fs, fs/promises, and node:fs/promises spellings", () => {
    expect('import { readFileSync } from "fs";').toMatch(FS_IMPORT_RE);
    expect('import { readFileSync } from "node:fs";').toMatch(FS_IMPORT_RE);
    expect('import { readFile } from "fs/promises";').toMatch(FS_IMPORT_RE);
    expect('import { readFile } from "node:fs/promises";').toMatch(FS_IMPORT_RE);
    expect('const fs = require("fs");').toMatch(FS_IMPORT_RE);
    expect('const fs = require("node:fs");').toMatch(FS_IMPORT_RE);
    expect('const fs = require("fs/promises");').toMatch(FS_IMPORT_RE);
    expect('const fs = require("node:fs/promises");').toMatch(FS_IMPORT_RE);
    // Never a false positive on an unrelated import that merely contains "fs".
    expect('import { statfs } from "./statfs-helpers.ts";').not.toMatch(FS_IMPORT_RE);
  });
});

// S070: a locked keychain (screen-lock, or an ACL mismatch between the dev
// shim and mattstack.app) pops a GUI dialog that blocks the real spawn
// forever; every seam.run must have a bounded deadline instead.
describe("createRealAgeKeySeam timeout (S070)", () => {
  test("a spawn that outlives its timeout rejects with a distinguished AgeKeyTimeoutError instead of hanging", async () => {
    const seam = createRealAgeKeySeam();
    await expect(seam.run(["sleep", "5"], { timeoutMs: 50 })).rejects.toThrow(AgeKeyTimeoutError);
  });

  test("the timeout error names the command without leaking a sensitive -w value", async () => {
    const seam = createRealAgeKeySeam();
    // sh -c's trailing args become unused positional params ($0, $1, ...) —
    // this still sleeps for the script text alone, while still carrying a
    // "-w <secret>" pair later in argv for redactArgv to find.
    const cmd = ["sh", "-c", "sleep 5", "argv0", "-w", "AGE-SECRET-KEY-should-not-appear"];
    try {
      await seam.run(cmd, { timeoutMs: 50, sensitive: true });
      throw new Error("expected a timeout");
    } catch (err) {
      expect(err).toBeInstanceOf(AgeKeyTimeoutError);
      expect((err as Error).message).not.toContain("AGE-SECRET-KEY-should-not-appear");
      expect((err as Error).message).toContain("<redacted>");
    }
  });

  test("a spawn that finishes well within its timeout resolves normally", async () => {
    const seam = createRealAgeKeySeam();
    const res = await seam.run(["echo", "hi"], { timeoutMs: 5000 });
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("hi");
  });
});
