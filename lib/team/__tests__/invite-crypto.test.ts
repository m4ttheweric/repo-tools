import { describe, test, expect } from "bun:test";
import {
  INVITE_ID_BYTES,
  generateKey,
  seal,
  open,
  encodeCode,
  decodeCode,
  sealReply,
  openReply,
  sealBytes,
  openBytes,
} from "../invite-crypto.ts";
import { UserActionableError } from "../../setup/errors.ts";
import type { InvitePointer } from "../../setup/intent.ts";

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

async function expectOpenThrows(ciphertextB64: string, key: Uint8Array, code: string): Promise<void> {
  let caught: unknown;
  try {
    await open(ciphertextB64, key);
  } catch (err) {
    caught = err;
  }
  expectUserActionableError(caught, code);
}

describe("seal/open", () => {
  test("round-trips a pointer", async () => {
    const key = generateKey();
    const pointer = samplePointer();
    const ciphertext = await seal(pointer, key);
    const opened = await open(ciphertext, key);
    expect(opened).toEqual(pointer);
  });

  test("flipping a ciphertext byte makes open() throw invite-unreadable", async () => {
    const key = generateKey();
    const ciphertext = await seal(samplePointer(), key);
    const bytes = Buffer.from(ciphertext, "base64");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    await expectOpenThrows(bytes.toString("base64"), key, "invite-unreadable");
  });

  test("wrong key makes open() throw invite-unreadable", async () => {
    const key = generateKey();
    const wrongKey = generateKey();
    const ciphertext = await seal(samplePointer(), key);
    await expectOpenThrows(ciphertext, wrongKey, "invite-unreadable");
  });

  test("truncated ciphertext throws invite-unreadable, not an unhandled throw", async () => {
    const key = generateKey();
    const ciphertext = await seal(samplePointer(), key);
    const truncated = ciphertext.slice(0, ciphertext.length - 8);
    await expectOpenThrows(truncated, key, "invite-unreadable");
  });

  test("garbage base64 throws invite-unreadable", async () => {
    const key = generateKey();
    await expectOpenThrows("not-valid-base64!!!", key, "invite-unreadable");
  });

  test("a v !== 1 payload throws invite-unreadable", async () => {
    const key = generateKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bogus = await sealBytes(new TextEncoder().encode(JSON.stringify({ v: 2, team: "acme" })), key, iv);
    await expectOpenThrows(bogus, key, "invite-unreadable");
  });

  test("non-JSON plaintext throws invite-unreadable", async () => {
    const key = generateKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bogus = await sealBytes(new TextEncoder().encode("not json"), key, iv);
    await expectOpenThrows(bogus, key, "invite-unreadable");
  });
});

describe("sealReply/openReply", () => {
  test("round-trips a reply with a handle", async () => {
    const key = generateKey();
    const reply = { v: 1 as const, agePublicKey: "age1qexampleexampleexample", handle: "alice" };
    const ciphertext = await sealReply(reply, key);
    const opened = await openReply(ciphertext, key);
    expect(opened).toEqual(reply);
  });

  test("round-trips a reply without the optional handle", async () => {
    const key = generateKey();
    const reply = { v: 1 as const, agePublicKey: "age1qexample" };
    const ciphertext = await sealReply(reply, key);
    const opened = await openReply(ciphertext, key);
    expect(opened).toEqual(reply);
  });

  test("tampered reply ciphertext throws invite-unreadable", async () => {
    const key = generateKey();
    const ciphertext = await sealReply({ v: 1, agePublicKey: "age1qexample" }, key);
    const bytes = Buffer.from(ciphertext, "base64");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    let caught: unknown;
    try {
      await openReply(bytes.toString("base64"), key);
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
});

describe("fixed vector (pins the algorithm)", () => {
  test("a hardcoded key/iv/plaintext produces the expected ciphertext", async () => {
    const key = Uint8Array.from(
      Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex"),
    );
    const iv = Uint8Array.from(Buffer.from("202122232425262728292a2b", "hex"));
    const plaintext = new TextEncoder().encode('{"v":1,"hello":"world"}');

    const ciphertextB64 = await sealBytes(plaintext, key, iv);

    expect(ciphertextB64).toBe("ICEiIyQlJicoKSorqRjQUlapNixyGS6irjrO26cmnvDjoh7hBhPV5x8s8HGqJf1zsLXw");

    const roundTripped = await openBytes(ciphertextB64, key);
    expect(new TextDecoder().decode(roundTripped)).toBe('{"v":1,"hello":"world"}');
  });
});
