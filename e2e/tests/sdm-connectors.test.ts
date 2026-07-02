import { describe, test, expect, afterAll } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { createTestHome, rt } from "../harness.ts";

describe("sdm connectors", () => {
  const { path: home, cleanup } = createTestHome();
  afterAll(() => cleanup());

  test("init scaffolds an executable connector", async () => {
    const res = await rt(["sdm", "connectors", "init", "demo"], { home });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("demo");
    expect(existsSync(join(home, ".rt", "sdm", "connectors", "demo.ts"))).toBe(true);
  });

  test("refresh discovers the template's two connections", async () => {
    const res = await rt(["sdm", "refresh"], { home });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("demo: 2 connections");
    expect(res.stdout).toContain("2 connections");
  });

  test("connectors test validates the scaffold", async () => {
    const res = await rt(["sdm", "connectors", "test", "demo"], { home });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("valid");
  });
});
