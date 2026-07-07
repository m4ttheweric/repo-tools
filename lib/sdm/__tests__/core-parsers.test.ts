import { describe, test, expect } from "bun:test";
import {
  parseSdmStatus,
  catalogResourceNames,
  resourceNeedsAccessRequest,
  interpretSdmStatus,
  classifySdmFailure,
  buildSdmSnapshot,
  type SdmFailureCode,
} from "../core.ts";

const STATUS_OUTPUT = [
  "DATASOURCE                    STATUS         ADDRESS",
  "example-shared-dev            connected      127.0.0.1:15432",
  "example-alpha-staging         not connected  127.0.0.1:15433",
  "example-bravo-qa              connected      127.0.0.1:15434 until 2026-07-02 03:00:00",
].join("\n");

const CATALOG_OUTPUT = [
  "ID            NAME                     TYPE       ACCESS",
  "rs-0a1b2c3d   example-alpha-staging    postgres   available",
  "rs-9f8e7d6c   example-shared-dev       postgres   granted",
  "not-a-row",
].join("\n");

describe("parseSdmStatus", () => {
  test("parses connected state, address, expiry, and section kind", () => {
    const m = parseSdmStatus(STATUS_OUTPUT);
    expect(m.get("example-shared-dev")).toEqual({
      connected: true, address: "127.0.0.1:15432", expiry: null, kind: "datasource",
    });
    expect(m.get("example-alpha-staging")!.connected).toBe(false);
    expect(m.get("example-bravo-qa")!.expiry).toBe("2026-07-02 03:00:00");
  });

  test("skips header rows and non-local addresses", () => {
    const m = parseSdmStatus("DATASOURCE  STATUS  ADDRESS\nfoo  connected  10.0.0.5:5432");
    expect(m.has("DATASOURCE")).toBe(false);
    expect(m.get("foo")!.address).toBeNull();
  });

  test("tags each row with its section so non-datasources can be dropped", () => {
    const out = [
      "CLUSTER       STATUS            ADDRESS           TYPE",
      "some-cluster  connected (auto)  127.0.0.1:10070   eksprofile",
      "",
      "DATASOURCE    STATUS     ADDRESS",
      "some-db       connected  127.0.0.1:15432",
      "",
      "WEBSITE       STATUS            ADDRESS           TYPE",
      "some-site     connected (auto)  127.0.0.1:10116   httpNoAuth",
    ].join("\n");
    const m = parseSdmStatus(out);
    expect(m.get("some-cluster")!.kind).toBe("cluster");
    expect(m.get("some-db")!.kind).toBe("datasource");
    expect(m.get("some-site")!.kind).toBe("website");
  });
});

describe("catalog parsing", () => {
  test("takes names from rs- rows only", () => {
    expect(catalogResourceNames(CATALOG_OUTPUT)).toEqual([
      "example-alpha-staging",
      "example-shared-dev",
    ]);
  });

  test("available column means an access request is needed", () => {
    expect(resourceNeedsAccessRequest(CATALOG_OUTPUT, "example-alpha-staging")).toBe(true);
    expect(resourceNeedsAccessRequest(CATALOG_OUTPUT, "example-shared-dev")).toBe(false);
    expect(resourceNeedsAccessRequest(CATALOG_OUTPUT, "missing")).toBe(false);
  });
});

describe("interpretSdmStatus", () => {
  test("ENOENT means not installed, with install URL", () => {
    const h = interpretSdmStatus("ENOENT", null, "");
    expect(h.status).toBe("not-installed");
    expect(h.message).toContain("strongdm.com");
  });

  test("ETIMEDOUT maps to error", () => {
    const h = interpretSdmStatus("ETIMEDOUT", null, "");
    expect(h.status).toBe("error");
    expect(h.message).toContain("did not respond");
  });

  test("nonzero exit with login text means not authenticated", () => {
    expect(interpretSdmStatus(null, 1, "You are not authenticated. please run: sdm login").status)
      .toBe("not-authenticated");
  });

  test("exit 0 but no table header means not authenticated", () => {
    expect(interpretSdmStatus(null, 0, "welcome banner, please log in").status)
      .toBe("not-authenticated");
  });

  test("healthy table output is ok", () => {
    expect(interpretSdmStatus(null, 0, STATUS_OUTPUT)).toEqual({ status: "ok", message: null });
  });
});

describe("classifySdmFailure", () => {
  test.each<[string, SdmFailureCode]>([
    ["You are not authenticated to strongDM. Please run: sdm login", "not-authenticated"],
    ["error: access token has expired", "not-authenticated"],
    ["cannot find datasource named \"example-alpha-staging\"", "no-access"],
    ["no resources matched", "no-access"],
    ["access denied to resource", "no-access"],
    ["connection refused: gateway unreachable", "other"],
    ["", "other"],
  ])("%s -> %s", (output, expected) => {
    expect(classifySdmFailure(output)).toBe(expected);
  });
});

describe("buildSdmSnapshot", () => {
  test("derives health and resources from one output", () => {
    const snap = buildSdmSnapshot(null, 0, STATUS_OUTPUT);
    expect(snap.health.status).toBe("ok");
    expect(snap.resources.get("example-shared-dev")!.connected).toBe(true);
  });

  test("logged-out output yields no resources", () => {
    const snap = buildSdmSnapshot(null, 1, "not authenticated");
    expect(snap.health.status).toBe("not-authenticated");
    expect(snap.resources.size).toBe(0);
  });
});
