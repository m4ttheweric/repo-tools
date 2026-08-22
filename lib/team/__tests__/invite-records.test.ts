import { describe, test, expect } from "bun:test";
import { readInviteRecords, upsertInviteRecord, removeInviteRecord, inviteRecordsPath, type InviteRecord } from "../invite-records.ts";
import { fakeProbes } from "../../setup/__tests__/fakes.ts";

const HOME = "/fake-home";
const SLUG = "acme";

function sampleRecord(overrides: Partial<InviteRecord> = {}): InviteRecord {
  return {
    id: "0102030405060708090a0b0c0d0e0f10",
    creatorSecret: "creator-secret-abc",
    keyB64: "base64keymaterial==",
    expiresAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("readInviteRecords", () => {
  test("returns an empty map when no file exists", () => {
    const p = fakeProbes({ home: HOME });
    expect(readInviteRecords(p, SLUG)).toEqual({});
  });

  test("returns an empty map for unparsable content rather than throwing", () => {
    const p = fakeProbes({ home: HOME, files: { [inviteRecordsPath(HOME, SLUG)]: "not json" } });
    expect(readInviteRecords(p, SLUG)).toEqual({});
  });
});

describe("upsertInviteRecord / removeInviteRecord", () => {
  test("round-trips a record and writes 0600", () => {
    const p = fakeProbes({ home: HOME });
    const rec = sampleRecord();

    upsertInviteRecord(p, SLUG, "alice", rec);

    expect(readInviteRecords(p, SLUG)).toEqual({ alice: rec });
    const path = inviteRecordsPath(HOME, SLUG);
    expect(p.calls.modes[path]).toBe(0o600);
  });

  test("upserting a second handle preserves the first", () => {
    const p = fakeProbes({ home: HOME });
    const alice = sampleRecord({ id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    const bob = sampleRecord({ id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });

    upsertInviteRecord(p, SLUG, "alice", alice);
    upsertInviteRecord(p, SLUG, "bob", bob);

    expect(readInviteRecords(p, SLUG)).toEqual({ alice, bob });
  });

  test("upserting the same handle again overwrites it", () => {
    const p = fakeProbes({ home: HOME });
    upsertInviteRecord(p, SLUG, "alice", sampleRecord({ creatorSecret: "first" }));
    upsertInviteRecord(p, SLUG, "alice", sampleRecord({ creatorSecret: "second" }));

    expect(readInviteRecords(p, SLUG)).toEqual({ alice: sampleRecord({ creatorSecret: "second" }) });
  });

  test("records for different team slugs never collide", () => {
    const p = fakeProbes({ home: HOME });
    upsertInviteRecord(p, "acme", "alice", sampleRecord({ creatorSecret: "acme-secret" }));
    upsertInviteRecord(p, "globex", "alice", sampleRecord({ creatorSecret: "globex-secret" }));

    expect(readInviteRecords(p, "acme")).toEqual({ alice: sampleRecord({ creatorSecret: "acme-secret" }) });
    expect(readInviteRecords(p, "globex")).toEqual({ alice: sampleRecord({ creatorSecret: "globex-secret" }) });
  });

  test("removeInviteRecord drops only the named handle", () => {
    const p = fakeProbes({ home: HOME });
    upsertInviteRecord(p, SLUG, "alice", sampleRecord());
    upsertInviteRecord(p, SLUG, "bob", sampleRecord({ id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }));

    removeInviteRecord(p, SLUG, "alice");

    const remaining = readInviteRecords(p, SLUG);
    expect(Object.keys(remaining)).toEqual(["bob"]);
  });

  test("removeInviteRecord on a handle that was never present is a no-op", () => {
    const p = fakeProbes({ home: HOME });
    expect(() => removeInviteRecord(p, SLUG, "ghost")).not.toThrow();
    expect(readInviteRecords(p, SLUG)).toEqual({});
  });
});
