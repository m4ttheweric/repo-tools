import { describe, test, expect } from "bun:test";
import { buildSdmConnections } from "../browse.ts";

const RES = [
  { name: "acme-db-qa", type: "postgres", tags: [] },
  { name: "acme-orphan-thing", type: "postgres", tags: [] },
];
const ENR = { "acme-db-qa": { label: "acme qa", tier: "qa", db: { schema: "acme" } } };

describe("buildSdmConnections", () => {
  test("enriched resource gets nice label/tier/db and a stable key", () => {
    const c = buildSdmConnections(RES, ENR).find(x => x.sdmResource === "acme-db-qa")!;
    expect(c).toMatchObject({ key: "sdm:acme-db-qa", label: "acme qa", tier: "qa", db: { schema: "acme" } });
  });
  test("unmapped resource shows raw name, no tier", () => {
    const c = buildSdmConnections(RES, ENR).find(x => x.sdmResource === "acme-orphan-thing")!;
    expect(c.label).toBe("acme-orphan-thing");
    expect(c.tier).toBeUndefined();
  });
});
