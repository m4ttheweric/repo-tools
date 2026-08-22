import { UserActionableError } from "../setup/errors.ts";
import type { InvitePointer } from "../setup/intent.ts";

export const INVITE_ID_BYTES = 16;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ID_HEX_PATTERN = new RegExp(`^[0-9a-f]{${INVITE_ID_BYTES * 2}}$`);

// Crockford base32: excludes I, L, O, U to avoid visual/audio ambiguity.
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += CROCKFORD_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

// Trailing bits beyond a whole byte are structural padding (always 0 for our
// fixed-length payloads), not data, so they're discarded rather than validated.
function base32Decode(str: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of str) {
    const idx = CROCKFORD_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new UserActionableError("invite-malformed", "invite code contains a character outside the Crockford alphabet");
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function chunk5(s: string): string {
  return s.match(/.{1,5}/g)!.join("-");
}

function normalizeCode(code: string): string {
  return code
    .replace(/[\s-]/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64Decode(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// TS's lib.dom BufferSource wants Uint8Array<ArrayBuffer>; the bare `Uint8Array`
// type used throughout this module's public surface widens to ArrayBufferLike.
// Every value here is actually ArrayBuffer-backed, so this narrowing is safe.
function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

/** The invite id doubles as AES-GCM's AAD, so it must be well-formed before it ever reaches WebCrypto. */
function parseIdHex(idHex: string): Uint8Array {
  if (!ID_HEX_PATTERN.test(idHex)) {
    throw new UserActionableError("invite-malformed", "invite id must be 32 lowercase hex characters");
  }
  return hexToBytes(idHex);
}

async function importAesKey(key: Uint8Array): Promise<CryptoKey> {
  // A 16/24-byte key imports fine and silently downgrades to AES-128/192-GCM; pin the 32-byte contract.
  if (key.length !== KEY_BYTES) {
    throw new UserActionableError("invite-unreadable", "invite key must be 32 bytes");
  }
  try {
    return await crypto.subtle.importKey("raw", bufferSource(key), "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch {
    throw new UserActionableError("invite-unreadable", "invite key is unreadable");
  }
}

export function generateKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

/** A fresh, CSPRNG invite id — the id format (`INVITE_ID_BYTES`, lowercase hex) is owned here, not by callers that only consume it. */
export function generateId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(INVITE_ID_BYTES)));
}

/**
 * AES-256-GCM seal of raw bytes with an explicit IV and AAD — the seam that
 * lets tests pin a fixed vector. `seal`/`sealReply` are thin wrappers that
 * supply a random IV and the invite id as AAD; callers needing determinism
 * (tests only) call this directly.
 */
export async function sealBytes(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array, aad: Uint8Array): Promise<string> {
  if (iv.length !== IV_BYTES) {
    throw new UserActionableError("invite-unreadable", "invite IV must be 12 bytes");
  }
  const cryptoKey = await importAesKey(key);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bufferSource(iv), additionalData: bufferSource(aad) },
      cryptoKey,
      bufferSource(plaintext),
    ),
  );
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv, 0);
  combined.set(ct, iv.length);
  return base64Encode(combined);
}

/** Inverse of sealBytes. Throws the raw WebCrypto/DOMException on auth failure (wrong key/AAD included) — callers map to UserActionableError. */
export async function openBytes(ciphertextB64: string, key: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const combined = base64Decode(ciphertextB64);
  if (combined.length <= IV_BYTES) {
    throw new Error("ciphertext too short to contain an IV");
  }
  const iv = combined.slice(0, IV_BYTES);
  const ct = combined.slice(IV_BYTES);
  const cryptoKey = await importAesKey(key);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bufferSource(iv), additionalData: bufferSource(aad) },
      cryptoKey,
      bufferSource(ct),
    ),
  );
}

async function sealJson(payload: unknown, key: Uint8Array, aad: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  return sealBytes(new TextEncoder().encode(JSON.stringify(payload)), key, iv, aad);
}

async function openJson(ciphertextB64: string, key: Uint8Array, aad: Uint8Array): Promise<unknown> {
  let plaintext: Uint8Array;
  try {
    plaintext = await openBytes(ciphertextB64, key, aad);
  } catch {
    throw new UserActionableError("invite-unreadable", "invite could not be decrypted");
  }
  try {
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new UserActionableError("invite-unreadable", "invite payload is not valid JSON");
  }
}

function assertInvitePointerShape(value: unknown): asserts value is InvitePointer {
  const p = value as Partial<InvitePointer> | null;
  const ok =
    typeof p === "object" &&
    p !== null &&
    p.v === 1 &&
    typeof p.team === "string" &&
    typeof p.name === "string" &&
    typeof p.remote === "string" &&
    p.remote.length > 0 &&
    typeof p.owner === "string";
  if (!ok) {
    throw new UserActionableError("invite-unreadable", "invite pointer payload is malformed");
  }
}

function assertReplyShape(value: unknown): asserts value is { v: 1; agePublicKey: string; handle?: string } {
  const r = value as { v?: unknown; agePublicKey?: unknown; handle?: unknown } | null;
  const ok =
    typeof r === "object" &&
    r !== null &&
    r.v === 1 &&
    typeof r.agePublicKey === "string" &&
    (r.handle === undefined || typeof r.handle === "string");
  if (!ok) {
    throw new UserActionableError("invite-unreadable", "invite reply payload is malformed");
  }
}

export async function seal(pointer: InvitePointer, key: Uint8Array, idHex: string): Promise<string> {
  return sealJson(pointer, key, parseIdHex(idHex));
}

export async function open(ciphertextB64: string, key: Uint8Array, idHex: string): Promise<InvitePointer> {
  const parsed = await openJson(ciphertextB64, key, parseIdHex(idHex));
  assertInvitePointerShape(parsed);
  return parsed;
}

export async function sealReply(reply: { v: 1; agePublicKey: string; handle?: string }, key: Uint8Array, idHex: string): Promise<string> {
  return sealJson(reply, key, parseIdHex(idHex));
}

export async function openReply(
  ciphertextB64: string,
  key: Uint8Array,
  idHex: string,
): Promise<{ v: 1; agePublicKey: string; handle?: string }> {
  const parsed = await openJson(ciphertextB64, key, parseIdHex(idHex));
  assertReplyShape(parsed);
  return parsed;
}

export function encodeCode(idHex: string, key: Uint8Array): string {
  const idBytes = parseIdHex(idHex);
  const combined = new Uint8Array(idBytes.length + key.length);
  combined.set(idBytes, 0);
  combined.set(key, idBytes.length);
  return chunk5(base32Encode(combined));
}

export function decodeCode(code: string): { idHex: string; key: Uint8Array } {
  const normalized = normalizeCode(code);
  // 16 id bytes + 32 key bytes, base32-encoded without padding, is always 77 chars.
  if (normalized.length !== 77) {
    throw new UserActionableError("invite-malformed", "invite code is the wrong length");
  }
  const bytes = base32Decode(normalized);
  const idBytes = bytes.slice(0, INVITE_ID_BYTES);
  // The 77th char carries only 1 payload bit, so two codes differing solely in
  // that trailing character's low nibble decode to the same id/key — a typo
  // there is silently absorbed rather than rejected as malformed.
  const key = bytes.slice(INVITE_ID_BYTES);
  return { idHex: bytesToHex(idBytes), key };
}
