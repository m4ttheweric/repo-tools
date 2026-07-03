import { describe, test, expect } from "bun:test";
import { validateConnectorOutput } from "../protocol.ts";

const good = {
  version: 1,
  connections: [
    { id: "alpha-staging", label: "Alpha Staging", sdmResource: "example-alpha-staging" },
    {
      id: "alpha-qa",
      label: "Alpha QA",
      sdmResource: "example-alpha-qa",
      tier: "qa",
      production: false,
      reasonSuggestion: "checking qa data",
      db: { database: "postgres", schema: "public", user: "postgres" },
      meta: { team: "demo" },
    },
  ],
};

describe("validateConnectorOutput", () => {
  test("accepts a valid document", () => {
    const r = validateConnectorOutput(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.connections).toHaveLength(2);
  });

  test("rejects non-objects and wrong versions", () => {
    expect(validateConnectorOutput(null).ok).toBe(false);
    expect(validateConnectorOutput("hi").ok).toBe(false);
    const r = validateConnectorOutput({ version: 2, connections: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("version");
  });

  test("pinpoints the failing connection and field", () => {
    const r = validateConnectorOutput({
      version: 1,
      connections: [good.connections[0], { id: "x", label: "X", sdmResource: "" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("connections[1].sdmResource");
  });

  test("rejects wrong optional field types", () => {
    const r = validateConnectorOutput({
      version: 1,
      connections: [{ id: "x", label: "X", sdmResource: "r", production: "yes" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("connections[0].production");
  });

  test("rejects a missing connections array", () => {
    const r = validateConnectorOutput({ version: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("connections");
  });

  test("accepts resolution on a connection", () => {
    const r = validateConnectorOutput({ version: 1, connections: [
      { id: "a", label: "A", sdmResource: "x", resolution: { source: "exact", candidates: ["x"] } }] });
    expect(r.ok).toBe(true);
  });

  test("rejects a bad resolution.source", () => {
    const r = validateConnectorOutput({ version: 1, connections: [
      { id: "a", label: "A", sdmResource: "x", resolution: { source: "guessed" } }] });
    expect(r.ok).toBe(false);
  });

  test("accepts unresolved entries", () => {
    const r = validateConnectorOutput({ version: 1, connections: [], unresolved: [
      { id: "g", label: "G", slug: "s", env: "qa", source: "none", candidates: [] }] });
    expect(r.ok).toBe(true);
  });

  test("rejects unresolved with a bad env", () => {
    const r = validateConnectorOutput({ version: 1, connections: [], unresolved: [
      { id: "g", label: "G", slug: "s", env: "prod-ish", source: "none", candidates: [] }] });
    expect(r.ok).toBe(false);
  });

  test("accepts allResources as an array of non-empty strings", () => {
    const r = validateConnectorOutput({ version: 1, connections: [], allResources: ["acme-x"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.allResources).toEqual(["acme-x"]);
  });

  test("rejects allResources with a non-string entry", () => {
    const r = validateConnectorOutput({ version: 1, connections: [], allResources: [123] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("allResources[0]");
  });

  test("rejects allResources that is not an array", () => {
    const r = validateConnectorOutput({ version: 1, connections: [], allResources: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("allResources");
  });
});
