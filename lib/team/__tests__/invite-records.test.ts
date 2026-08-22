import { describe, test, expect } from "bun:test";
import { readInviteRecords, upsertInviteRecord, removeInviteRecord, inviteRecordsPath, type InviteRecord } from "../invite-records.ts";
import { UserActionableError } from "../../setup/errors.ts";
import { fakeProbes } from "../../setup/__tests__/fakes.ts";
import { dirname } from "path";

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

  test("a JSON null body throws unreadable-records rather than crashing", () => {
    const p = fakeProbes({ home: HOME, files: { [inviteRecordsPath(HOME, SLUG)]: "null" } });
    let caught: unknown;
    try {
      readInviteRecords(p, SLUG);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UserActionableError);
    expect((caught as UserActionableError).code).toBe("unreadable-records");
  });

  test("a JSON array body throws unreadable-records rather than silently discarding records", () => {
    const p = fakeProbes({ home: HOME, files: { [inviteRecordsPath(HOME, SLUG)]: "[]" } });
    let caught: unknown;
    try {
      readInviteRecords(p, SLUG);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UserActionableError);
    expect((caught as UserActionableError).code).toBe("unreadable-records");
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

  test('a handle of "__proto__" is stored and read back as a real record, not lost to the prototype', () => {
    const p = fakeProbes({ home: HOME });
    const rec = sampleRecord();

    upsertInviteRecord(p, SLUG, "__proto__", rec);

    const records = readInviteRecords(p, SLUG);
    expect(Object.keys(records)).toEqual(["__proto__"]);
    expect(records["__proto__"]).toEqual(rec);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype); // sanity: the global prototype was never touched
  });

  test("mkdirp for the invites directory uses 0700", () => {
    const p = fakeProbes({ home: HOME });
    upsertInviteRecord(p, SLUG, "alice", sampleRecord());
    const dir = dirname(inviteRecordsPath(HOME, SLUG));
    expect(p.calls.modes[dir]).toBe(0o700);
  });

  test("an expired record is pruned on the next upsert", () => {
    const path = inviteRecordsPath(HOME, SLUG);
    const early = fakeProbes({ home: HOME, now: new Date("2026-01-01T00:00:00.000Z") });
    upsertInviteRecord(early, SLUG, "alice", sampleRecord({ expiresAt: "2026-02-01T00:00:00.000Z" })); // not expired yet at write time

    // Simulate time passing: a fresh probes instance, seeded from what the
    // first write actually persisted, with a `now` past alice's expiresAt.
    const later = fakeProbes({ home: HOME, now: new Date("2026-10-01T00:00:00.000Z"), files: { [path]: early.calls.writes[path]! } });
    upsertInviteRecord(later, SLUG, "bob", sampleRecord({ id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", expiresAt: "2026-11-01T00:00:00.000Z" }));

    const records = readInviteRecords(later, SLUG);
    expect(Object.keys(records)).toEqual(["bob"]);
  });
});
