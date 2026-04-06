/**
 * PortAllocator unit tests (12 tests)
 *
 * All tests use isolated temp directories — never touch real ~/.rt state.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PortAllocator } from "../port-allocator.ts";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "rt-port-alloc-test-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// ── allocate ─────────────────────────────────────────────────────────────────

describe("allocate", () => {
  test("allocates starting from 10000", () => {
    const pa = new PortAllocator(dataDir);
    const port = pa.allocate("test");
    expect(port).toBeGreaterThanOrEqual(10000);
  });

  test("two allocations return different ports", () => {
    const pa = new PortAllocator(dataDir);
    const p1 = pa.allocate("a");
    const p2 = pa.allocate("b");
    expect(p1).not.toBe(p2);
  });

  test("allocated ports are tracked in list()", () => {
    const pa = new PortAllocator(dataDir);
    const p = pa.allocate("svc");
    const entries = pa.list();
    expect(entries.some((e) => e.port === p && e.label === "svc")).toBe(true);
  });

  test("isAllocated returns true after allocate", () => {
    const pa = new PortAllocator(dataDir);
    const p = pa.allocate("svc");
    expect(pa.isAllocated(p)).toBe(true);
  });

  test("isAllocated returns false for unallocated port", () => {
    const pa = new PortAllocator(dataDir);
    expect(pa.isAllocated(10000)).toBe(false);
  });
});

// ── release ──────────────────────────────────────────────────────────────────

describe("release by port", () => {
  test("release removes a port", () => {
    const pa = new PortAllocator(dataDir);
    const p = pa.allocate("svc");
    pa.release(p);
    expect(pa.isAllocated(p)).toBe(false);
  });

  test("released port can be reallocated", () => {
    const pa = new PortAllocator(dataDir);
    const p1 = pa.allocate("svc");
    pa.release(p1);
    const p2 = pa.allocate("svc2");
    expect(p2).toBe(p1); // should reuse the freed slot
  });

  test("release of unknown port is a no-op", () => {
    const pa = new PortAllocator(dataDir);
    expect(() => pa.release(55555)).not.toThrow();
  });
});

// ── releaseByLabel ───────────────────────────────────────────────────────────

describe("releaseByLabel", () => {
  test("releases by label", () => {
    const pa = new PortAllocator(dataDir);
    const p = pa.allocate("my-service");
    pa.releaseByLabel("my-service");
    expect(pa.isAllocated(p)).toBe(false);
  });

  test("releaseByLabel is no-op for unknown label", () => {
    const pa = new PortAllocator(dataDir);
    expect(() => pa.releaseByLabel("nonexistent")).not.toThrow();
  });
});

// ── Persistence ──────────────────────────────────────────────────────────────

describe("persistence", () => {
  test("allocations survive reinstantiation", () => {
    const pa1 = new PortAllocator(dataDir);
    const p = pa1.allocate("svc");

    const pa2 = new PortAllocator(dataDir);
    expect(pa2.isAllocated(p)).toBe(true);
    expect(pa2.list().some((e) => e.label === "svc")).toBe(true);
  });

  test("releases are persisted", () => {
    const pa1 = new PortAllocator(dataDir);
    const p = pa1.allocate("svc");
    pa1.release(p);

    const pa2 = new PortAllocator(dataDir);
    expect(pa2.isAllocated(p)).toBe(false);
  });

  test("persist file is valid JSON", () => {
    const pa = new PortAllocator(dataDir);
    pa.allocate("svc");
    const content = readFileSync(join(dataDir, "allocated-ports.json"), "utf8");
    expect(() => JSON.parse(content)).not.toThrow();
  });
});
