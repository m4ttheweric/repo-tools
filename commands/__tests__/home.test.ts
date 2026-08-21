import { describe, test, expect, spyOn } from "bun:test";
import { DEFAULT_USER_REPO_URL, gatherHomeState, homeInit, type HomeProbes, type SopsYamlSeam } from "../home.ts";
import { STATE_DIR_NAMES } from "../../lib/home/init-plan.ts";
import type { ExecResult, ExecSeam } from "../../lib/home/init-exec.ts";
import { renderSopsYaml, type AgeExecResult, type AgeKeySeam } from "../../lib/home/age-key.ts";
import { mattstackHome } from "../../lib/rt-paths.ts";
import { join } from "path";

const FAKE_PUBLIC_KEY = "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const FAKE_PRIVATE_KEY = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";
const SOPS_YAML_PATH = join(mattstackHome(), "user", ".sops.yaml");
const KEY = "mbp-14";

/** In-memory .sops.yaml — never touches the real filesystem. */
class FakeSopsYamlSeam implements SopsYamlSeam {
  files = new Map<string, string>();
  writes: { path: string; content: string }[] = [];

  constructor(initial?: { path: string; content: string }) {
    if (initial) this.files.set(initial.path, initial.content);
  }

  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  write(path: string, content: string): void {
    this.files.set(path, content);
    this.writes.push({ path, content });
  }
}

/** No key in the keychain yet; ensureAgeKey mints one — never touches the real keychain. */
class FakeAgeKeySeam implements AgeKeySeam {
  calls: string[][] = [];

  async run(cmd: string[]): Promise<AgeExecResult> {
    this.calls.push(cmd);
    if (cmd[1] === "find-generic-password") {
      return { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
    }
    if (cmd[0] === "age-keygen") {
      return { code: 0, stdout: `# public key: ${FAKE_PUBLIC_KEY}\n${FAKE_PRIVATE_KEY}\n`, stderr: "" };
    }
    if (cmd[1] === "add-generic-password") return { code: 0, stdout: "", stderr: "" };
    throw new Error(`FakeAgeKeySeam: unexpected call ${cmd.join(" ")}`);
  }
}

function fakeProbes(overrides: Partial<HomeProbes>): HomeProbes {
  return {
    isGitRepo: () => false,
    exists: () => false,
    readSymlinkTarget: () => null,
    ...overrides,
  };
}

const FULLY_PROVISIONED_PROBES = (): HomeProbes =>
  fakeProbes({
    isGitRepo: (dir) => dir.endsWith("/user"),
    exists: () => true,
    readSymlinkTarget: (path) => (path.endsWith("/skills.jsonc") ? join("user", "skills.jsonc") : null),
  });

describe("gatherHomeState", () => {
  test("userRepoPresent is true only when user/ is itself a git clone", () => {
    const probes = fakeProbes({ isGitRepo: (dir) => dir.endsWith("/user") });
    const state = gatherHomeState("/home", probes, KEY);
    expect(state.userRepoPresent).toBe(true);
  });

  test("a plain (non-git) user/ directory does not count as a clone", () => {
    const probes = fakeProbes({ exists: (path) => path.endsWith("/user"), isGitRepo: () => false });
    const state = gatherHomeState("/home", probes, KEY);
    expect(state.userRepoPresent).toBe(false);
  });

  test("machineKeyFilePresent reflects the root machine-key file only", () => {
    const probes = fakeProbes({ exists: (path) => path === "/home/machine-key" });
    const state = gatherHomeState("/home", probes, KEY);
    expect(state.machineKeyFilePresent).toBe(true);
  });

  test("profileDirPresent checks user/local/<key>/, not just any local dir", () => {
    const probes = fakeProbes({ exists: (path) => path === join("/home", "user", "local", KEY) });
    const state = gatherHomeState("/home", probes, KEY);
    expect(state.profileDirPresent).toBe(true);
  });

  test("skillsSymlinkPresent is true only when the symlink target is exactly user/skills.jsonc", () => {
    const correct = fakeProbes({ readSymlinkTarget: () => join("user", "skills.jsonc") });
    expect(gatherHomeState("/home", correct, KEY).skillsSymlinkPresent).toBe(true);

    const wrong = fakeProbes({ readSymlinkTarget: () => "/some/other/path" });
    expect(gatherHomeState("/home", wrong, KEY).skillsSymlinkPresent).toBe(false);
  });

  test("skillsSymlinkBlocked is true only when a REAL file (not a symlink) sits at the root path", () => {
    const realFile = fakeProbes({ readSymlinkTarget: () => null, exists: (path) => path.endsWith("/skills.jsonc") });
    expect(gatherHomeState("/home", realFile, KEY).skillsSymlinkBlocked).toBe(true);

    const absent = fakeProbes({ readSymlinkTarget: () => null, exists: () => false });
    expect(gatherHomeState("/home", absent, KEY).skillsSymlinkBlocked).toBe(false);

    const validSymlink = fakeProbes({ readSymlinkTarget: () => join("user", "skills.jsonc") });
    expect(gatherHomeState("/home", validSymlink, KEY).skillsSymlinkBlocked).toBe(false);
  });

  test("stateDirsMissing lists only the state dirs absent under home", () => {
    const probes = fakeProbes({ exists: (path) => path === "/home/rt" || path === "/home/deck" });
    const state = gatherHomeState("/home", probes, KEY);
    expect(state.stateDirsMissing).toEqual(STATE_DIR_NAMES.filter((n) => n !== "rt" && n !== "deck"));
  });
});

/** Records argv only; used to prove init-step execution and idempotence. */
class FakeSeam implements ExecSeam {
  calls: { kind: string; arg: unknown }[] = [];
  constructor(private opts: { failRun?: (cmd: string[]) => boolean } = {}) {}

  async run(cmd: string[]): Promise<ExecResult> {
    this.calls.push({ kind: "run", arg: cmd });
    if (this.opts.failRun?.(cmd)) return { code: 1, stdout: "", stderr: "boom" };
    return { code: 0, stdout: "", stderr: "" };
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.calls.push({ kind: "writeFile", arg: { path, content } });
  }
  async mkdirp(path: string): Promise<void> {
    this.calls.push({ kind: "mkdirp", arg: path });
  }
  async writeSymlink(path: string, target: string): Promise<void> {
    this.calls.push({ kind: "writeSymlink", arg: { path, target } });
  }
}

/** Runs `homeInit`, catching the `process.exit` call the failure paths make. */
async function runHomeInit(
  probes: HomeProbes,
  exec: ExecSeam,
  ageKeySeam: AgeKeySeam = new FakeAgeKeySeam(),
  args: string[] = [],
  sopsYamlSeam: SopsYamlSeam = new FakeSopsYamlSeam(),
  key: string = KEY,
): Promise<{ exitCode: number | undefined; logs: string[]; errors: string[] }> {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit");
  });
  const logs: string[] = [];
  const errors: string[] = [];
  spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "));
  });
  spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    errors.push(parts.map(String).join(" "));
  });
  try {
    await homeInit(args, {}, probes, exec, ageKeySeam, sopsYamlSeam, key);
    return { exitCode: undefined, logs, errors };
  } catch {
    const code = exitSpy.mock.calls.at(-1)?.[0] as number | undefined;
    return { exitCode: code, logs, errors };
  } finally {
    exitSpy.mockRestore();
    (console.log as unknown as { mockRestore: () => void }).mockRestore();
    (console.error as unknown as { mockRestore: () => void }).mockRestore();
  }
}

describe("homeInit", () => {
  test("fully provisioned: runs no step, but still ensures the age key (idempotent)", async () => {
    const seam = new FakeSeam();
    const ageKeySeam = new FakeAgeKeySeam();
    const { exitCode } = await runHomeInit(FULLY_PROVISIONED_PROBES(), seam, ageKeySeam);

    expect(exitCode).toBeUndefined();
    expect(seam.calls).toEqual([]);
    expect(ageKeySeam.calls.some((c) => c[1] === "find-generic-password")).toBe(true);
  });

  test("fully provisioned: backfills .sops.yaml when it's missing (a home repo that predates this step)", async () => {
    const seam = new FakeSeam();
    const ageKeySeam = new FakeAgeKeySeam();
    const sopsYamlSeam = new FakeSopsYamlSeam();

    await runHomeInit(FULLY_PROVISIONED_PROBES(), seam, ageKeySeam, [], sopsYamlSeam);

    expect(sopsYamlSeam.files.get(SOPS_YAML_PATH)).toBe(renderSopsYaml(FAKE_PUBLIC_KEY));
  });

  test("fully provisioned: an existing .sops.yaml with the current key's recipient is left untouched", async () => {
    const seam = new FakeSeam();
    const ageKeySeam = new FakeAgeKeySeam();
    const sopsYamlSeam = new FakeSopsYamlSeam({ path: SOPS_YAML_PATH, content: renderSopsYaml(FAKE_PUBLIC_KEY) });

    await runHomeInit(FULLY_PROVISIONED_PROBES(), seam, ageKeySeam, [], sopsYamlSeam);

    expect(sopsYamlSeam.writes).toEqual([]);
  });

  test("fully provisioned: an existing .sops.yaml with a stale recipient (key rotation) is rewritten", async () => {
    const seam = new FakeSeam();
    const ageKeySeam = new FakeAgeKeySeam();
    const sopsYamlSeam = new FakeSopsYamlSeam({ path: SOPS_YAML_PATH, content: renderSopsYaml("age1stale") });

    await runHomeInit(FULLY_PROVISIONED_PROBES(), seam, ageKeySeam, [], sopsYamlSeam);

    expect(sopsYamlSeam.files.get(SOPS_YAML_PATH)).toBe(renderSopsYaml(FAKE_PUBLIC_KEY));
  });

  test("fully provisioned --dry-run: never touches the age key either", async () => {
    const seam = new FakeSeam();
    const ageKeySeam = new FakeAgeKeySeam();
    const sopsYamlSeam = new FakeSopsYamlSeam();
    const { exitCode } = await runHomeInit(FULLY_PROVISIONED_PROBES(), seam, ageKeySeam, ["--dry-run"], sopsYamlSeam);

    expect(exitCode).toBeUndefined();
    expect(ageKeySeam.calls).toEqual([]);
    expect(sopsYamlSeam.writes).toEqual([]);
  });

  test("a fresh, fully successful init clones with the default URL, mints the age key, and writes .sops.yaml after adoption", async () => {
    const seam = new FakeSeam();
    const ageKeySeam = new FakeAgeKeySeam();
    const sopsYamlSeam = new FakeSopsYamlSeam();
    const { exitCode, logs } = await runHomeInit(fakeProbes({}), seam, ageKeySeam, [], sopsYamlSeam);

    expect(exitCode).toBeUndefined();
    const cloneCall = seam.calls.find((c) => c.kind === "run") as { kind: string; arg: string[] } | undefined;
    expect(cloneCall?.arg).toEqual(["git", "clone", DEFAULT_USER_REPO_URL, "user"]);
    expect(ageKeySeam.calls.some((c) => c[1] === "find-generic-password")).toBe(true);
    expect(ageKeySeam.calls.some((c) => c[0] === "age-keygen")).toBe(true);
    expect(sopsYamlSeam.files.get(SOPS_YAML_PATH)).toBe(renderSopsYaml(FAKE_PUBLIC_KEY));

    // The mint (and the age-key-ready line) happen BEFORE the success line —
    // never print success ahead of a mint that could still fail.
    const readyIdx = logs.findIndex((l) => l.includes("age key ready"));
    const successIdx = logs.findIndex((l) => l.includes("is provisioned"));
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    expect(successIdx).toBeGreaterThan(readyIdx);
  });

  test("--url overrides the default clone URL", async () => {
    const seam = new FakeSeam();
    const customUrl = "https://github.com/example/mattstack-home.git";
    await runHomeInit(fakeProbes({}), seam, new FakeAgeKeySeam(), ["--url", customUrl]);

    const cloneCall = seam.calls.find((c) => c.kind === "run") as { kind: string; arg: string[] } | undefined;
    expect(cloneCall?.arg).toEqual(["git", "clone", customUrl, "user"]);
  });

  test("--dry-run never touches the age key or runs any step, even on a fresh (not-yet-provisioned) home", async () => {
    const seam = new FakeSeam();
    const ageKeySeam = new FakeAgeKeySeam();
    const { exitCode } = await runHomeInit(fakeProbes({}), seam, ageKeySeam, ["--dry-run"]);

    expect(exitCode).toBeUndefined();
    expect(seam.calls).toEqual([]);
    expect(ageKeySeam.calls).toEqual([]);
  });

  test("a failing init step aborts before the age key is ever touched", async () => {
    const seam = new FakeSeam({ failRun: (cmd) => cmd[0] === "git" });
    const ageKeySeam = new FakeAgeKeySeam();
    const { exitCode } = await runHomeInit(fakeProbes({}), seam, ageKeySeam);

    expect(exitCode).toBe(1);
    expect(ageKeySeam.calls).toEqual([]);
  });

  test("a real file at the skills.jsonc root path: still runs every other step, still mints the age key, but exits 1", async () => {
    const seam = new FakeSeam();
    const ageKeySeam = new FakeAgeKeySeam();
    const probes = fakeProbes({
      readSymlinkTarget: () => null,
      exists: (path) => path.endsWith("skills.jsonc"),
    });

    const { exitCode, errors } = await runHomeInit(probes, seam, ageKeySeam);

    expect(exitCode).toBe(1);
    expect(errors.some((e) => e.includes("refusing to overwrite"))).toBe(true);
    expect(ageKeySeam.calls.some((c) => c[1] === "find-generic-password")).toBe(true);
    expect(seam.calls.some((c) => c.kind === "writeSymlink")).toBe(false);
  });

  test("a real file at the skills.jsonc root path, --dry-run: reports the block and exits cleanly without running anything", async () => {
    const seam = new FakeSeam();
    const ageKeySeam = new FakeAgeKeySeam();
    const probes = fakeProbes({
      readSymlinkTarget: () => null,
      exists: (path) => path.endsWith("skills.jsonc"),
    });

    const { exitCode, errors } = await runHomeInit(probes, seam, ageKeySeam, ["--dry-run"]);

    expect(exitCode).toBeUndefined();
    expect(errors.some((e) => e.includes("refusing to overwrite"))).toBe(true);
    expect(seam.calls).toEqual([]);
    expect(ageKeySeam.calls).toEqual([]);
  });
});
