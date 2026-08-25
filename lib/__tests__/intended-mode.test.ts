import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveIntendedMode } from "../dev-mode.ts";
import { setSetting } from "../settings/write.ts";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "rt-intent-"));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("resolveIntendedMode", () => {
  test("setting present wins, provenance 'setting'", () => {
    setSetting("mattstack.mode", "dev", "machine");
    expect(resolveIntendedMode()).toEqual({ mode: "dev", provenance: "setting" });
  });

  test("unset: derives from wrapper — script at ~/.local/bin/rt means dev", () => {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "rt"), "#!/bin/sh\necho dev\n");
    expect(resolveIntendedMode()).toEqual({ mode: "dev", provenance: "derived-from-wrapper" });
  });

  test("unset, no wrapper: prod (the fresh-machine / clean-room default)", () => {
    expect(resolveIntendedMode()).toEqual({ mode: "prod", provenance: "derived-from-wrapper" });
  });

  test("garbage setting value falls through to derivation, never throws", () => {
    setSetting("mattstack.mode", "chaos" as any, "machine");
    expect(resolveIntendedMode().provenance).toBe("derived-from-wrapper");
  });
});
