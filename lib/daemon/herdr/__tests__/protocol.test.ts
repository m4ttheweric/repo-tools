import { describe, test, expect } from "bun:test";
import { encodeRequest, parseLine } from "../protocol.ts";

describe("encodeRequest", () => {
  test("emits one newline-terminated JSON line with id/method/params", () => {
    const line = encodeRequest({ id: "r1", method: "pane.list", params: { workspace_id: "w9" } });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ id: "r1", method: "pane.list", params: { workspace_id: "w9" } });
  });
  test("omits params when undefined", () => {
    expect(JSON.parse(encodeRequest({ id: "r2", method: "ping" }))).toEqual({ id: "r2", method: "ping" });
  });
});

describe("parseLine", () => {
  test("parses a success response", () => {
    expect(parseLine('{"id":"r1","result":{"type":"pong"}}'))
      .toEqual({ id: "r1", result: { type: "pong" } });
  });
  test("parses an error response", () => {
    expect(parseLine('{"id":"r3","error":{"code":"workspace_not_found","message":"nope"}}'))
      .toEqual({ id: "r3", error: { code: "workspace_not_found", message: "nope" } });
  });
  test("returns null for blank or non-JSON lines", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
    expect(parseLine("not json")).toBeNull();
  });
  test("returns null for a JSON line without an id", () => {
    expect(parseLine('{"result":{}}')).toBeNull();
  });
});
