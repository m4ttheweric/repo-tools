import { describe, test, expect } from "bun:test";
import { buildSdmConnections } from "../browse.ts";

const RES = [
  { name: "assured-pgr-qa", type: "postgres", tags: [], standingAccess: true },
  { name: "assured-orphan-thing", type: "postgres", tags: [], standingAccess: false },
];
const ENR = { "assured-pgr-qa": { label: "progressive qa", tier: "qa", db: { schema: "assured" } } };

describe("buildSdmConnections", () => {
  test("enriched resource gets nice label/tier/db and a stable key", () => {
    const c = buildSdmConnections(RES, ENR).find(x => x.sdmResource === "assured-pgr-qa")!;
    expect(c).toMatchObject({ key: "sdm:assured-pgr-qa", label: "progressive qa", tier: "qa", db: { schema: "assured" } });
  });
  test("carries standingAccess from the scanned resource", () => {
    const conns = buildSdmConnections(RES, ENR);
    expect(conns.find(x => x.sdmResource === "assured-pgr-qa")!.standingAccess).toBe(true);
    expect(conns.find(x => x.sdmResource === "assured-orphan-thing")!.standingAccess).toBe(false);
  });
  test("unmapped resource shows raw name, no tier", () => {
    const c = buildSdmConnections(RES, ENR).find(x => x.sdmResource === "assured-orphan-thing")!;
    expect(c.label).toBe("assured-orphan-thing");
    expect(c.tier).toBeUndefined();
  });
});
