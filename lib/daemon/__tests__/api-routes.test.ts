/**
 * matchProcessApiRoute unit tests — pure mapping of an HTTP method + path to a
 * daemon command + payload for the process REST surface on :9401. No server.
 */

import { describe, test, expect } from "bun:test";
import { matchProcessApiRoute } from "../api-routes.ts";

describe("matchProcessApiRoute", () => {
  test("GET /api/processes -> process:describe", () => {
    expect(matchProcessApiRoute("GET", "/api/processes"))
      .toEqual({ cmd: "process:describe", payload: {} });
  });

  test("POST /api/processes/:id/stop -> process:stop", () => {
    expect(matchProcessApiRoute("POST", "/api/processes/1-assured-primary/stop"))
      .toEqual({ cmd: "process:stop", payload: { id: "1-assured-primary" } });
  });

  test("POST /api/processes/:id/restart -> process:respawn", () => {
    expect(matchProcessApiRoute("POST", "/api/processes/p1/restart"))
      .toEqual({ cmd: "process:respawn", payload: { id: "p1" } });
  });

  test("POST /api/processes/:id/start -> process:respawn", () => {
    expect(matchProcessApiRoute("POST", "/api/processes/p1/start"))
      .toEqual({ cmd: "process:respawn", payload: { id: "p1" } });
  });

  test("decodes a url-encoded id", () => {
    expect(matchProcessApiRoute("POST", "/api/processes/a%2Fb/stop"))
      .toEqual({ cmd: "process:stop", payload: { id: "a/b" } });
  });

  test("wrong method for a control action returns null", () => {
    expect(matchProcessApiRoute("GET", "/api/processes/p1/stop")).toBeNull();
  });

  test("unknown control action returns null", () => {
    expect(matchProcessApiRoute("POST", "/api/processes/p1/explode")).toBeNull();
  });

  test("unrelated path returns null", () => {
    expect(matchProcessApiRoute("GET", "/api/repos")).toBeNull();
  });

  test("POST /api/processes (list path, wrong method) returns null", () => {
    expect(matchProcessApiRoute("POST", "/api/processes")).toBeNull();
  });
});
