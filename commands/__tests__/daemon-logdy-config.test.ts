/**
 * `materializeLogdyConfig` writes the logdy UI config that
 * `rt daemon logs --web` points `--config` at. It must not resurrect a
 * durable-looking file at the rt/ top level: RT-33's whole point is that
 * rt/ is either sqlite or an external tool's mandatory input, never a
 * scratch file a viewer regenerates on every launch.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { materializeLogdyConfig } from "../daemon.ts";
import { rtDir, tmpDir } from "../../lib/rt-paths.ts";

const legacyPath = () => join(rtDir(), "logdy-pino-columns.json");
const newPath = () => join(tmpDir(), "logdy-pino-columns.json");

describe("materializeLogdyConfig", () => {
  afterEach(() => {
    rmSync(newPath(), { force: true });
    rmSync(legacyPath(), { force: true });
  });

  test("writes the config under rt/tmp, creating the dir if absent", () => {
    rmSync(tmpDir(), { recursive: true, force: true });
    expect(existsSync(tmpDir())).toBe(false);

    const path = materializeLogdyConfig();

    expect(path).toBe(newPath());
    expect(existsSync(newPath())).toBe(true);
    const parsed = JSON.parse(readFileSync(newPath(), "utf8"));
    expect(parsed.columns.map((c: { id: string }) => c.id)).toEqual(["time", "level", "module", "msg", "fields"]);
  });

  test("best-effort removes a lingering top-level rt/logdy-pino-columns.json", () => {
    mkdirSync(rtDir(), { recursive: true });
    writeFileSync(legacyPath(), "{}");

    materializeLogdyConfig();

    expect(existsSync(legacyPath())).toBe(false);
  });

  test("is a no-op removal when no legacy file exists", () => {
    rmSync(legacyPath(), { force: true });
    expect(() => materializeLogdyConfig()).not.toThrow();
    expect(existsSync(legacyPath())).toBe(false);
  });

  test("does not rewrite the file when content is already current", () => {
    const first = materializeLogdyConfig();
    const before = readFileSync(first, "utf8");
    materializeLogdyConfig();
    const after = readFileSync(first, "utf8");
    expect(after).toBe(before);
  });
});
