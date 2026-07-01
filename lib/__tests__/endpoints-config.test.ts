import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadEndpoints, loadEndpointState, saveEndpointState } from "../endpoints-config.ts";

function tmp() { return mkdtempSync(join(tmpdir(), "rt-ep-")); }

describe("loadEndpoints", () => {
  test("reads declared endpoints from endpoints.json", () => {
    const d = tmp();
    try {
      writeFileSync(join(d, "endpoints.json"), JSON.stringify({
        endpoints: [
          { port: 4000, name: "app", mode: "forward" },
          { port: 4001, name: "auth", mode: "bounce", returnParam: "rt_return" },
        ],
      }));
      expect(loadEndpoints(d)).toEqual([
        { port: 4000, name: "app", mode: "forward" },
        { port: 4001, name: "auth", mode: "bounce", returnParam: "rt_return" },
      ]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("returns [] when the file is missing", () => {
    const d = tmp();
    try { expect(loadEndpoints(d)).toEqual([]); } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("drops entries with an invalid mode or non-integer port", () => {
    const d = tmp();
    try {
      writeFileSync(join(d, "endpoints.json"), JSON.stringify({
        endpoints: [
          { port: 4000, name: "ok", mode: "forward" },
          { port: 1.5, name: "badport", mode: "forward" },
          { port: 4001, name: "badmode", mode: "nope" },
        ],
      }));
      expect(loadEndpoints(d)).toEqual([{ port: 4000, name: "ok", mode: "forward" }]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("bounce endpoints get default returnParam when not provided", () => {
    const d = tmp();
    try {
      writeFileSync(join(d, "endpoints.json"), JSON.stringify({
        endpoints: [{ port: 4001, name: "auth", mode: "bounce" }],
      }));
      const result = loadEndpoints(d);
      expect(result).toEqual([{ port: 4001, name: "auth", mode: "bounce", returnParam: "rt_return" }]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("bounce endpoints preserve explicit returnParam", () => {
    const d = tmp();
    try {
      writeFileSync(join(d, "endpoints.json"), JSON.stringify({
        endpoints: [{ port: 4002, name: "auth2", mode: "bounce", returnParam: "back" }],
      }));
      const result = loadEndpoints(d);
      expect(result).toEqual([{ port: 4002, name: "auth2", mode: "bounce", returnParam: "back" }]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("forward endpoints have no returnParam key", () => {
    const d = tmp();
    try {
      writeFileSync(join(d, "endpoints.json"), JSON.stringify({
        endpoints: [{ port: 4000, name: "app", mode: "forward" }],
      }));
      const result = loadEndpoints(d);
      expect("returnParam" in result[0]!).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("endpoint state round-trips", () => {
  test("save then load returns the same state", () => {
    const d = tmp();
    try {
      const s = { forward: { "4000": "wt:dev" }, bounceEnabled: [4001] };
      saveEndpointState(d, s);
      expect(loadEndpointState(d)).toEqual(s);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("missing state file yields empty defaults", () => {
    const d = tmp();
    try { expect(loadEndpointState(d)).toEqual({ forward: {}, bounceEnabled: [] }); }
    finally { rmSync(d, { recursive: true, force: true }); }
  });
});
