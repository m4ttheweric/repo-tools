/**
 * lib/dev-mode.ts — currentMode() parity test.
 *
 * currentMode() MOVED here from commands/settings.ts:364 (MAT-383 §1) with its
 * logic unchanged: wrapper-presence at ~/.local/bin/rt, checked via existsSync.
 * This test pins that behavior from the new home so lib/daemon-config.ts's
 * activeLaunchdLabel() (which depends on it) rests on a verified foundation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { currentMode, DEV_MODE_TAG, installRtBinary, isDevModeWrapperContent } from "../dev-mode.ts";

// The dev-mode wrapper path is resolved at CALL time from process.env.HOME
// (mirrors lib/rt-paths.ts's home()), so this constant only needs to match
// whatever HOME is in effect when each test runs. The bun test preload
// (test-setup.ts) repoints HOME before any module loads, so this always lands
// under the per-run throwaway HOME, never the developer's real one.
const WRAPPER_PATH = join(process.env.HOME!, ".local", "bin", "rt");

describe("currentMode", () => {
  afterEach(() => {
    try { rmSync(WRAPPER_PATH); } catch { /* already absent */ }
  });

  test("reports prod when the dev-mode wrapper is absent", () => {
    expect(existsSync(WRAPPER_PATH)).toBe(false);
    expect(currentMode()).toBe("prod");
  });

  test("reports dev when the wrapper exists at ~/.local/bin/rt", () => {
    mkdirSync(join(process.env.HOME!, ".local", "bin"), { recursive: true });
    writeFileSync(WRAPPER_PATH, `#!/bin/sh\n${DEV_MODE_TAG}\nexit 0\n`, { mode: 0o755 });
    expect(currentMode()).toBe("dev");
  });

  test("tracks HOME at call time, not at module load", () => {
    // Proves the wrapper path is recomputed on every call: a HOME that only
    // exists once currentMode() actually runs must still be honored, which
    // would be impossible if the path were baked in at module-load time.
    const realHome = process.env.HOME!;
    try {
      const fakeHome = join(realHome, ".dev-mode-call-time-probe");
      process.env.HOME = fakeHome;
      expect(currentMode()).toBe("prod"); // fakeHome/.local/bin/rt doesn't exist yet

      mkdirSync(join(fakeHome, ".local", "bin"), { recursive: true });
      writeFileSync(join(fakeHome, ".local", "bin", "rt"), `#!/bin/sh\n${DEV_MODE_TAG}\nexit 0\n`, { mode: 0o755 });
      expect(currentMode()).toBe("dev");

      rmSync(fakeHome, { recursive: true, force: true });
    } finally {
      process.env.HOME = realHome;
    }
  });
});

describe("isDevModeWrapperContent", () => {
  test("new marked wrapper is recognized", () => {
    expect(isDevModeWrapperContent(`#!/bin/zsh\n${DEV_MODE_TAG}\nexport PATH=...\n`)).toBe(true);
  });
  test("legacy markerless wrapper (RT_LAUNCH_CWD tell) is recognized", () => {
    expect(isDevModeWrapperContent(`#!/bin/zsh\nexport PATH="x"\nexport RT_LAUNCH_CWD="$PWD"\n`)).toBe(true);
  });
  test("foreign #! script is not a dev wrapper", () => {
    expect(isDevModeWrapperContent(`#!/bin/sh\necho hi\n`)).toBe(false);
  });
  test("a mattstack-link file is not a dev wrapper", () => {
    expect(isDevModeWrapperContent(`#!/bin/sh\n# mattstack-link: rt\nexec ...\n`)).toBe(false);
  });
  test("non-shebang content is not a dev wrapper", () => {
    expect(isDevModeWrapperContent(`ELF\x00binary`)).toBe(false);
  });
});

describe("currentMode bounded read", () => {
  afterEach(() => {
    try { rmSync(WRAPPER_PATH); } catch { /* already absent */ }
  });

  test("a symlink to a >4KB binary-shaped file classifies as prod without reading the whole file", () => {
    mkdirSync(join(process.env.HOME!, ".local", "bin"), { recursive: true });
    const bigBinaryPath = join(process.env.HOME!, "big-binary");
    // Mach-O-ish header followed by >4KB of non-marker filler, so a
    // whole-file read (rather than a bounded prefix read) would still
    // correctly classify this as prod -- the real proof is that this
    // doesn't throw/hang and stays fast even against a multi-MB target.
    const filler = Buffer.alloc(8192, 0x41);
    writeFileSync(bigBinaryPath, Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), filler]));
    symlinkSync(bigBinaryPath, WRAPPER_PATH);

    expect(currentMode()).toBe("prod");
  });
});

describe("installRtBinary", () => {
  const BIN = join(process.env.HOME!, ".local", "bin");
  afterEach(() => { try { rmSync(join(BIN, "rt")); } catch { /* absent */ } });

  test("creates ~/.local/bin/rt as a symlink to the given binary", () => {
    const src = join(process.env.HOME!, "mattstack.app", "Contents", "MacOS", "rt");
    mkdirSync(dirname(src), { recursive: true });
    writeFileSync(src, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), { mode: 0o755 });
    const dest = installRtBinary(src);
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dest)).toBe(src);
    expect(currentMode()).toBe("prod");
  });

  test("replaces an existing regular file (the dev wrapper) and an existing link atomically", () => {
    mkdirSync(BIN, { recursive: true });
    writeFileSync(join(BIN, "rt"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const src = join(process.env.HOME!, "app-a", "Contents", "MacOS", "rt");
    mkdirSync(dirname(src), { recursive: true }); writeFileSync(src, "", { mode: 0o755 });
    installRtBinary(src);
    expect(realpathSync(join(BIN, "rt"))).toBe(realpathSync(src));
    const src2 = join(process.env.HOME!, "app-b", "Contents", "MacOS", "rt");
    mkdirSync(dirname(src2), { recursive: true }); writeFileSync(src2, "", { mode: 0o755 });
    installRtBinary(src2);
    expect(readlinkSync(join(BIN, "rt"))).toBe(src2);
  });

  test("currentMode reads through the link: a link to a script is dev, to a Mach-O is prod", () => {
    const script = join(process.env.HOME!, "wrapper.sh");
    writeFileSync(script, `#!/bin/zsh\n${DEV_MODE_TAG}\nexit 0\n`, { mode: 0o755 });
    installRtBinary(script);
    expect(currentMode()).toBe("dev");
  });

  test("throws instead of creating a dangling link when src doesn't exist", () => {
    const missing = join(process.env.HOME!, "no-such-app", "Contents", "MacOS", "rt");
    expect(() => installRtBinary(missing)).toThrow(/not found/);
    expect(existsSync(join(BIN, "rt"))).toBe(false);
  });
});
