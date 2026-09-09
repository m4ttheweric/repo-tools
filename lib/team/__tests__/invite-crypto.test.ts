import { describe, test, expect } from "bun:test";
import {
  INVITE_ID_BYTES,
  generateKey,
  seal,
  open,
  encodeCode,
  decodeCode,
  extractInviteCode,
  sealReply,
  openReply,
  sealBytes,
  openBytes,
} from "../invite-crypto.ts";
import { UserActionableError } from "../../setup/errors.ts";
import type { InvitePointer } from "../../setup/intent.ts";
import fixture from "../fixtures/invite-code-inputs.json";

const SAMPLE_ID_HEX = "0102030405060708090a0b0c0d0e0f10";
const OTHER_ID_HEX = "1112131415161718191a1b1c1d1e1f20";

function idHexToBytes(idHex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(idHex, "hex"));
}

function samplePointer(): InvitePointer {
  return {
    v: 1,
    team: "acme",
    name: "Acme Claims",
    remote: "git@github.com:acme/repo.git",
    owner: "alice",
    forge: "github",
    createdAt: "2026-08-21T00:00:00.000Z",
  };
}

function expectUserActionableError(err: unknown, code: string): void {
  expect(err).toBeInstanceOf(UserActionableError);
  expect((err as UserActionableError).code).toBe(code);
}

async function expectOpenThrows(ciphertextB64: string, key: Uint8Array, idHex: string, code: string): Promise<void> {
  let caught: unknown;
  try {
    await open(ciphertextB64, key, idHex);
  } catch (err) {
    caught = err;
  }
  expectUserActionableError(caught, code);
}

describe("seal/open", () => {
  test("round-trips a pointer", async () => {
    const key = generateKey();
    const pointer = samplePointer();
    const ciphertext = await seal(pointer, key, SAMPLE_ID_HEX);
    const opened = await open(ciphertext, key, SAMPLE_ID_HEX);
    expect(opened).toEqual(pointer);
  });

  test("flipping a byte in the nonce region makes open() throw invite-unreadable", async () => {
    const key = generateKey();
    const ciphertext = await seal(samplePointer(), key, SAMPLE_ID_HEX);
    const bytes = Buffer.from(ciphertext, "base64");
    bytes[0] = bytes[0]! ^ 0xff; // byte 0 sits inside the 12-byte IV prefix
    await expectOpenThrows(bytes.toString("base64"), key, SAMPLE_ID_HEX, "invite-unreadable");
  });

  test("flipping a byte in the ciphertext region makes open() throw invite-unreadable", async () => {
    const key = generateKey();
    const ciphertext = await seal(samplePointer(), key, SAMPLE_ID_HEX);
    const bytes = Buffer.from(ciphertext, "base64");
    const mid = 12 + Math.floor((bytes.length - 12 - 16) / 2); // between the IV and the 16-byte tag
    bytes[mid] = bytes[mid]! ^ 0xff;
    await expectOpenThrows(bytes.toString("base64"), key, SAMPLE_ID_HEX, "invite-unreadable");
  });

  test("flipping a byte in the tag region makes open() throw invite-unreadable", async () => {
    const key = generateKey();
    const ciphertext = await seal(samplePointer(), key, SAMPLE_ID_HEX);
    const bytes = Buffer.from(ciphertext, "base64");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff; // last byte sits inside the 16-byte tag
    await expectOpenThrows(bytes.toString("base64"), key, SAMPLE_ID_HEX, "invite-unreadable");
  });

  test("wrong key makes open() throw invite-unreadable", async () => {
    const key = generateKey();
    const wrongKey = generateKey();
    const ciphertext = await seal(samplePointer(), key, SAMPLE_ID_HEX);
    await expectOpenThrows(ciphertext, wrongKey, SAMPLE_ID_HEX, "invite-unreadable");
  });

  test("opening under a different invite id (AAD) throws invite-unreadable", async () => {
    const key = generateKey();
    const ciphertext = await seal(samplePointer(), key, SAMPLE_ID_HEX);
    await expectOpenThrows(ciphertext, key, OTHER_ID_HEX, "invite-unreadable");
  });

  test("truncated ciphertext throws invite-unreadable, not an unhandled throw", async () => {
    const key = generateKey();
    const ciphertext = await seal(samplePointer(), key, SAMPLE_ID_HEX);
    const truncated = ciphertext.slice(0, ciphertext.length - 8);
    await expectOpenThrows(truncated, key, SAMPLE_ID_HEX, "invite-unreadable");
  });

  test("garbage base64 throws invite-unreadable", async () => {
    const key = generateKey();
    await expectOpenThrows("not-valid-base64!!!", key, SAMPLE_ID_HEX, "invite-unreadable");
  });

  test("a v !== 1 payload throws invite-unreadable", async () => {
    const key = generateKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bogus = await sealBytes(
      new TextEncoder().encode(JSON.stringify({ v: 2, team: "acme" })),
      key,
      iv,
      idHexToBytes(SAMPLE_ID_HEX),
    );
    await expectOpenThrows(bogus, key, SAMPLE_ID_HEX, "invite-unreadable");
  });

  test("non-JSON plaintext throws invite-unreadable", async () => {
    const key = generateKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bogus = await sealBytes(new TextEncoder().encode("not json"), key, iv, idHexToBytes(SAMPLE_ID_HEX));
    await expectOpenThrows(bogus, key, SAMPLE_ID_HEX, "invite-unreadable");
  });

  test("a pointer payload with an empty remote throws invite-unreadable", async () => {
    const key = generateKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bogus = await sealBytes(
      new TextEncoder().encode(JSON.stringify({ v: 1, team: "acme", name: "Acme", remote: "", owner: "alice" })),
      key,
      iv,
      idHexToBytes(SAMPLE_ID_HEX),
    );
    await expectOpenThrows(bogus, key, SAMPLE_ID_HEX, "invite-unreadable");
  });

  test("a pointer payload with a non-string team throws invite-unreadable", async () => {
    const key = generateKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bogus = await sealBytes(
      new TextEncoder().encode(
        JSON.stringify({ v: 1, team: 42, name: "Acme", remote: "git@github.com:acme/repo.git", owner: "alice" }),
      ),
      key,
      iv,
      idHexToBytes(SAMPLE_ID_HEX),
    );
    await expectOpenThrows(bogus, key, SAMPLE_ID_HEX, "invite-unreadable");
  });

  test("IV is fresh per seal — same plaintext and key produce distinct IVs and ciphertexts", async () => {
    const key = generateKey();
    const pointer = samplePointer();
    const ivs = new Set<string>();
    const ciphertexts = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const ciphertext = await seal(pointer, key, SAMPLE_ID_HEX);
      const bytes = Buffer.from(ciphertext, "base64");
      ivs.add(bytes.subarray(0, 12).toString("hex"));
      ciphertexts.add(ciphertext);
    }
    expect(ivs.size).toBe(20);
    expect(ciphertexts.size).toBe(20);
  });

  test("seal rejects a malformed invite id", async () => {
    const key = generateKey();
    let caught: unknown;
    try {
      await seal(samplePointer(), key, "not-hex");
    } catch (err) {
      caught = err;
    }
    expectUserActionableError(caught, "invite-malformed");
  });
});

describe("sealReply/openReply", () => {
  test("round-trips a reply with a handle", async () => {
    const key = generateKey();
    const reply = { v: 1 as const, agePublicKey: "age1qexampleexampleexample", handle: "alice" };
    const ciphertext = await sealReply(reply, key, SAMPLE_ID_HEX);
    const opened = await openReply(ciphertext, key, SAMPLE_ID_HEX);
    expect(opened).toEqual(reply);
  });

  test("round-trips a reply without the optional handle", async () => {
    const key = generateKey();
    const reply = { v: 1 as const, agePublicKey: "age1qexample" };
    const ciphertext = await sealReply(reply, key, SAMPLE_ID_HEX);
    const opened = await openReply(ciphertext, key, SAMPLE_ID_HEX);
    expect(opened).toEqual(reply);
  });

  test("tampered reply ciphertext throws invite-unreadable", async () => {
    const key = generateKey();
    const ciphertext = await sealReply({ v: 1, agePublicKey: "age1qexample" }, key, SAMPLE_ID_HEX);
    const bytes = Buffer.from(ciphertext, "base64");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    let caught: unknown;
    try {
      await openReply(bytes.toString("base64"), key, SAMPLE_ID_HEX);
    } catch (err) {
      caught = err;
    }
    expectUserActionableError(caught, "invite-unreadable");
  });

  test("a reply payload missing agePublicKey throws invite-unreadable", async () => {
    const key = generateKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bogus = await sealBytes(new TextEncoder().encode(JSON.stringify({ v: 1 })), key, iv, idHexToBytes(SAMPLE_ID_HEX));
    let caught: unknown;
    try {
      await openReply(bogus, key, SAMPLE_ID_HEX);
    } catch (err) {
      caught = err;
    }
    expectUserActionableError(caught, "invite-unreadable");
  });
});

describe("encodeCode/decodeCode", () => {
  test("round-trips a random id/key", () => {
    const key = generateKey();
    const idBytes = crypto.getRandomValues(new Uint8Array(INVITE_ID_BYTES));
    const idHex = Buffer.from(idBytes).toString("hex");
    const code = encodeCode(idHex, key);
    const decoded = decodeCode(code);
    expect(decoded.idHex).toBe(idHex);
    expect(decoded.key).toEqual(key);
  });

  test("round-trips over many random 48-byte payloads", () => {
    for (let i = 0; i < 50; i++) {
      const idBytes = crypto.getRandomValues(new Uint8Array(INVITE_ID_BYTES));
      const idHex = Buffer.from(idBytes).toString("hex");
      const key = generateKey();
      const code = encodeCode(idHex, key);
      const decoded = decodeCode(code);
      expect(decoded.idHex).toBe(idHex);
      expect(decoded.key).toEqual(key);
    }
  });

  test("encodes as dash-chunked groups of 5, 77 chars of payload", () => {
    const key = generateKey();
    const idHex = "00".repeat(INVITE_ID_BYTES);
    const code = encodeCode(idHex, key);
    expect(code.replace(/-/g, "").length).toBe(77);
    expect(code).toMatch(/^([0-9A-Z]{5}-){15}[0-9A-Z]{2}$/);
  });

  test("decodes a lowercased code", () => {
    const key = generateKey();
    const idHex = Buffer.from(crypto.getRandomValues(new Uint8Array(INVITE_ID_BYTES))).toString("hex");
    const code = encodeCode(idHex, key);
    const decoded = decodeCode(code.toLowerCase());
    expect(decoded.idHex).toBe(idHex);
    expect(decoded.key).toEqual(key);
  });

  test("decodes a code with dashes and surrounding whitespace stripped", () => {
    const key = generateKey();
    const idHex = Buffer.from(crypto.getRandomValues(new Uint8Array(INVITE_ID_BYTES))).toString("hex");
    const code = encodeCode(idHex, key);
    const mangled = `  ${code.replace(/-/g, "")}  `;
    const decoded = decodeCode(mangled);
    expect(decoded.idHex).toBe(idHex);
    expect(decoded.key).toEqual(key);
  });

  test("maps Crockford aliases O -> 0 and I/L -> 1", () => {
    const zeros = decodeCode("0".repeat(77));
    const withO = decodeCode("O".repeat(77));
    expect(withO).toEqual(zeros);

    const ones = decodeCode("1".repeat(77));
    const withI = decodeCode("I".repeat(77));
    const withL = decodeCode("L".repeat(77));
    expect(withI).toEqual(ones);
    expect(withL).toEqual(ones);
  });

  test("a 76-char code throws invite-malformed", () => {
    const key = generateKey();
    const idHex = "00".repeat(INVITE_ID_BYTES);
    const short = encodeCode(idHex, key).replace(/-/g, "").slice(0, 76);
    let caught: unknown;
    try {
      decodeCode(short);
    } catch (err) {
      caught = err;
    }
    expectUserActionableError(caught, "invite-malformed");
  });

  test("a 78-char code throws invite-malformed", () => {
    const key = generateKey();
    const idHex = "00".repeat(INVITE_ID_BYTES);
    const long = encodeCode(idHex, key).replace(/-/g, "") + "0";
    let caught: unknown;
    try {
      decodeCode(long);
    } catch (err) {
      caught = err;
    }
    expectUserActionableError(caught, "invite-malformed");
  });

  test("a character outside the Crockford alphabet throws invite-malformed", () => {
    const key = generateKey();
    const idHex = "00".repeat(INVITE_ID_BYTES);
    const bad = "!" + encodeCode(idHex, key).replace(/-/g, "").slice(1);
    let caught: unknown;
    try {
      decodeCode(bad);
    } catch (err) {
      caught = err;
    }
    expectUserActionableError(caught, "invite-malformed");
  });

  test("'U' (excluded from the Crockford alphabet, not an alias) throws invite-malformed", () => {
    const key = generateKey();
    const idHex = "00".repeat(INVITE_ID_BYTES);
    const bad = "U" + encodeCode(idHex, key).replace(/-/g, "").slice(1);
    let caught: unknown;
    try {
      decodeCode(bad);
    } catch (err) {
      caught = err;
    }
    expectUserActionableError(caught, "invite-malformed");
  });

  test("encodeCode rejects idHex that isn't exactly 32 lowercase hex characters", () => {
    const key = generateKey();

    let caught: unknown;
    try {
      encodeCode("gg".repeat(INVITE_ID_BYTES), key); // non-hex chars would otherwise silently mint an all-zero id
    } catch (err) {
      caught = err;
    }
    expectUserActionableError(caught, "invite-malformed");

    expect(() => encodeCode(SAMPLE_ID_HEX.toUpperCase(), key)).toThrow(UserActionableError);
    expect(() => encodeCode(SAMPLE_ID_HEX.slice(0, 30), key)).toThrow(UserActionableError);
  });
});

describe("fixed vector (pins the algorithm)", () => {
  test("a hardcoded key/iv/aad/plaintext produces the expected ciphertext", async () => {
    const key = Uint8Array.from(
      Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex"),
    );
    const iv = Uint8Array.from(Buffer.from("202122232425262728292a2b", "hex"));
    const aad = Uint8Array.from(Buffer.from("2c2d2e2f303132333435363738393a3b", "hex"));
    const plaintext = new TextEncoder().encode('{"v":1,"hello":"world"}');

    const ciphertextB64 = await sealBytes(plaintext, key, iv, aad);

    expect(ciphertextB64).toBe("ICEiIyQlJicoKSorqRjQUlapNixyGS6irjrO26cmnvDjoh70hoofBAuE4fBuene3gMco");

    const roundTripped = await openBytes(ciphertextB64, key, aad);
    expect(new TextDecoder().decode(roundTripped)).toBe('{"v":1,"hello":"world"}');

    await expect(openBytes(ciphertextB64, key, new Uint8Array(16))).rejects.toThrow();
  });
});

describe("extractInviteCode", () => {
  for (const c of fixture as { why: string; input: string; expect: string | null }[]) {
    test(c.why, () => {
      expect(extractInviteCode(c.input)).toBe(c.expect);
    });
  }

  test("every accepted case decodes", () => {
    for (const c of fixture as { input: string; expect: string | null }[]) {
      if (c.expect === null) continue;
      expect(() => decodeCode(extractInviteCode(c.input)!)).not.toThrow();
    }
  });
});
