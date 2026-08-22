/**
 * Invite relay client — the only thing rt ever sends to the mattstack-hosted
 * switchboard relay. Every payload here is opaque (ciphertext/blob strings
 * and ids); sealing/opening belongs to callers. The relay must never see a
 * plaintext team name, slug, handle, or remote — only ciphertext and
 * timestamps cross this boundary.
 */

import type { Probes } from "../setup/probes.ts";
import { UserActionableError } from "../setup/errors.ts";

export const DEFAULT_INVITE_RELAY_URL = "https://switchboard.mattstack.dev";

const REQUEST_TIMEOUT_MS = 10_000;

export function inviteRelayUrl(env: Record<string, string | undefined>): string {
  const override = env.RT_INVITE_RELAY_URL;
  return stripTrailingSlash(override && override.length > 0 ? override : DEFAULT_INVITE_RELAY_URL);
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface RelayClient {
  /** POST /v1/invites {ciphertext, expiresAt} */
  create(ciphertext: string, expiresAt: string): Promise<{ id: string; creatorSecret: string }>;
  /** GET /v1/invites/:id — 404/410 (expired or claimed away) both read as "gone" */
  fetch(id: string): Promise<{ ciphertext: string } | "gone">;
  /** POST /v1/invites/:id/redeem — 409 means another redeemer already won the race */
  redeem(id: string): Promise<"redeemed" | "already">;
  /** POST /v1/invites/:id/reply {blob} */
  reply(id: string, blob: string): Promise<void>;
  /** GET /v1/invites/:id/reply, Authorization: Bearer creatorSecret — 404 means no reply posted yet */
  readReply(id: string, creatorSecret: string): Promise<{ blob: string } | "none">;
  /** DELETE /v1/invites/:id, Authorization: Bearer creatorSecret — 404 (already gone) is treated as success, not failure: revocation is idempotent */
  delete(id: string, creatorSecret: string): Promise<void>;
}

interface RawResponse {
  status: number;
  body: string;
  path: string;
}

function relayUnreachable(): UserActionableError {
  return new UserActionableError("relay-unreachable", "could not reach the invite relay");
}

function relayError(status: number, path: string): UserActionableError {
  return new UserActionableError("relay-error", `${status} ${path}`);
}

function parseJsonObject(body: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

const OPAQUE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** This module is the declared privacy boundary — an id that isn't a relay-minted opaque id must never reach the path, closing the gap a caller mistake (passing a handle or slug by accident) would otherwise open. */
function assertOpaqueId(id: string): void {
  if (!OPAQUE_ID_PATTERN.test(id)) {
    throw new UserActionableError("relay-error", "invite id must be a 32-character hex id");
  }
}

export function createRelayClient(fetchFn: Probes["fetch"], baseUrl: string): RelayClient {
  const base = stripTrailingSlash(baseUrl);

  async function send(
    path: string,
    opts: { method: string; json?: unknown; headers?: Record<string, string> },
  ): Promise<RawResponse> {
    const res = await fetchFn(`${base}${path}`, {
      method: opts.method,
      headers: opts.json !== undefined ? { "Content-Type": "application/json", ...opts.headers } : opts.headers,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    // status 0 is Probes' own encoding of "network never happened" — it must
    // stay distinct from a real 4xx/5xx below (unreachable is not the same
    // fact as invalid or expired).
    if (res.status === 0) throw relayUnreachable();
    return { status: res.status, body: res.body, path };
  }

  return {
    async create(ciphertext, expiresAt) {
      const res = await send("/v1/invites", { method: "POST", json: { ciphertext, expiresAt } });
      if (!isSuccess(res.status)) throw relayError(res.status, res.path);
      const parsed = parseJsonObject(res.body);
      if (typeof parsed?.id !== "string" || typeof parsed?.creatorSecret !== "string") {
        throw relayError(res.status, res.path);
      }
      return { id: parsed.id, creatorSecret: parsed.creatorSecret };
    },

    async fetch(id) {
      assertOpaqueId(id);
      const res = await send(`/v1/invites/${encodeURIComponent(id)}`, { method: "GET" });
      if (res.status === 404 || res.status === 410) return "gone";
      if (!isSuccess(res.status)) throw relayError(res.status, res.path);
      const parsed = parseJsonObject(res.body);
      if (typeof parsed?.ciphertext !== "string") throw relayError(res.status, res.path);
      return { ciphertext: parsed.ciphertext };
    },

    async redeem(id) {
      assertOpaqueId(id);
      const res = await send(`/v1/invites/${encodeURIComponent(id)}/redeem`, { method: "POST" });
      if (res.status === 409) return "already";
      if (!isSuccess(res.status)) throw relayError(res.status, res.path);
      return "redeemed";
    },

    async reply(id, blob) {
      assertOpaqueId(id);
      const res = await send(`/v1/invites/${encodeURIComponent(id)}/reply`, { method: "POST", json: { blob } });
      if (!isSuccess(res.status)) throw relayError(res.status, res.path);
    },

    async readReply(id, creatorSecret) {
      assertOpaqueId(id);
      const res = await send(`/v1/invites/${encodeURIComponent(id)}/reply`, {
        method: "GET",
        headers: { Authorization: `Bearer ${creatorSecret}` },
      });
      if (res.status === 404) return "none";
      if (!isSuccess(res.status)) throw relayError(res.status, res.path);
      const parsed = parseJsonObject(res.body);
      if (typeof parsed?.blob !== "string") throw relayError(res.status, res.path);
      return { blob: parsed.blob };
    },

    async delete(id, creatorSecret) {
      assertOpaqueId(id);
      const res = await send(`/v1/invites/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${creatorSecret}` },
      });
      // Revocation is idempotent: an invite the relay already expired or
      // reaped reads as done, not as a failure to revoke.
      if (res.status === 404) return;
      if (!isSuccess(res.status)) throw relayError(res.status, res.path);
    },
  };
}
