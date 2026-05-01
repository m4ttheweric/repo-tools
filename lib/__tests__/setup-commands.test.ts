import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { detectInstallCommand } from "../setup-commands.ts";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "rt-setup-")); });
afterEach(()  => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

describe("detectInstallCommand", () => {
  test("returns null when no lockfile is present", () => {
    expect(detectInstallCommand(tmp)).toBeNull();
  });

  test("bun.lock → bun install", () => {
    writeFileSync(join(tmp, "bun.lock"), "");
    expect(detectInstallCommand(tmp)).toEqual(["bun", "install"]);
  });

  test("bun.lockb → bun install", () => {
    writeFileSync(join(tmp, "bun.lockb"), "");
    expect(detectInstallCommand(tmp)).toEqual(["bun", "install"]);
  });

  test("pnpm-lock.yaml → pnpm install --frozen-lockfile", () => {
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "");
    expect(detectInstallCommand(tmp)).toEqual(["pnpm", "install", "--frozen-lockfile"]);
  });

  test("yarn.lock → yarn install --frozen-lockfile", () => {
    writeFileSync(join(tmp, "yarn.lock"), "");
    expect(detectInstallCommand(tmp)).toEqual(["yarn", "install", "--frozen-lockfile"]);
  });

  test("package-lock.json → npm ci", () => {
    writeFileSync(join(tmp, "package-lock.json"), "");
    expect(detectInstallCommand(tmp)).toEqual(["npm", "ci"]);
  });

  test("Gemfile.lock → bundle install", () => {
    writeFileSync(join(tmp, "Gemfile.lock"), "");
    expect(detectInstallCommand(tmp)).toEqual(["bundle", "install"]);
  });

  test("go.sum → go mod download", () => {
    writeFileSync(join(tmp, "go.sum"), "");
    expect(detectInstallCommand(tmp)).toEqual(["go", "mod", "download"]);
  });

  test("requirements.txt → pip install -r requirements.txt", () => {
    writeFileSync(join(tmp, "requirements.txt"), "");
    expect(detectInstallCommand(tmp)).toEqual(["pip", "install", "-r", "requirements.txt"]);
  });

  test("multiple lockfiles → first match wins (bun.lock over pnpm-lock.yaml)", () => {
    writeFileSync(join(tmp, "bun.lock"), "");
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "");
    expect(detectInstallCommand(tmp)).toEqual(["bun", "install"]);
  });
});
