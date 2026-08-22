import { describe, test, expect } from "bun:test";
import { createRelayClient, inviteRelayUrl, DEFAULT_INVITE_RELAY_URL } from "../relay-client.ts";
import { generateKey, seal, sealReply } from "../invite-crypto.ts";
import { UserActionableError } from "../../setup/errors.ts";
import type { InvitePointer } from "../../setup/intent.ts";
import type { Probes } from "../../setup/probes.ts";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface RouteResult {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

function recordingFetch(handler: (call: RecordedCall) => RouteResult): { fetchFn: Probes["fetch"]; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn: Probes["fetch"] = async (url, init) => {
    const call: RecordedCall = { url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body };
    calls.push(call);
    const res = handler(call);
    return { status: res.status, body: res.body, headers: res.headers ?? {} };
  };
  return { fetchFn, calls };
}

function singleRouteFetch(res: RouteResult): { fetchFn: Probes["fetch"]; calls: RecordedCall[] } {
  return recordingFetch(() => res);
}

async function expectUserActionableError(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UserActionableError);
  expect((caught as UserActionableError).code).toBe(code);
}

const BASE_URL = "https://relay.test";
const ID_HEX = "0102030405060708090a0b0c0d0e0f10";

describe("inviteRelayUrl", () => {
  test("defaults to the switchboard host", () => {
    expect(inviteRelayUrl({})).toBe(DEFAULT_INVITE_RELAY_URL);
    expect(DEFAULT_INVITE_RELAY_URL).toBe("https://switchboard.mattstack.dev");
  });

  test("honors RT_INVITE_RELAY_URL", () => {
    expect(inviteRelayUrl({ RT_INVITE_RELAY_URL: "http://localhost:9" })).toBe("http://localhost:9");
  });

  test("ignores an empty override and strips a trailing slash", () => {
    expect(inviteRelayUrl({ RT_INVITE_RELAY_URL: "" })).toBe(DEFAULT_INVITE_RELAY_URL);
    expect(inviteRelayUrl({ RT_INVITE_RELAY_URL: "http://localhost:9/" })).toBe("http://localhost:9");
  });
});

describe("create", () => {
  test("POSTs JSON to /v1/invites and returns id/creatorSecret", async () => {
    const { fetchFn, calls } = singleRouteFetch({
      status: 200,
      body: JSON.stringify({ id: ID_HEX, creatorSecret: "secret-xyz" }),
    });
    const client = createRelayClient(fetchFn, BASE_URL);

    const result = await client.create("ciphertext-blob", "2026-09-01T00:00:00.000Z");

    expect(result).toEqual({ id: ID_HEX, creatorSecret: "secret-xyz" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/invites`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ ciphertext: "ciphertext-blob", expiresAt: "2026-09-01T00:00:00.000Z" });
  });

  test("a malformed 2xx body throws relay-error", async () => {
    const { fetchFn } = singleRouteFetch({ status: 200, body: "not json" });
    const client = createRelayClient(fetchFn, BASE_URL);
    await expectUserActionableError(client.create("ct", "2026-09-01T00:00:00.000Z"), "relay-error");
  });
});

describe("fetch", () => {
  test("404 reads as gone", async () => {
    const { fetchFn } = singleRouteFetch({ status: 404, body: "" });
    const client = createRelayClient(fetchFn, BASE_URL);
    expect(await client.fetch(ID_HEX)).toBe("gone");
  });

  test("410 reads as gone", async () => {
    const { fetchFn } = singleRouteFetch({ status: 410, body: "" });
    const client = createRelayClient(fetchFn, BASE_URL);
    expect(await client.fetch(ID_HEX)).toBe("gone");
  });

  test("200 returns the ciphertext", async () => {
    const { fetchFn, calls } = singleRouteFetch({ status: 200, body: JSON.stringify({ ciphertext: "ct-abc" }) });
    const client = createRelayClient(fetchFn, BASE_URL);
    expect(await client.fetch(ID_HEX)).toEqual({ ciphertext: "ct-abc" });
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/invites/${ID_HEX}`);
    expect(calls[0]!.method).toBe("GET");
  });

  test("a 2xx body missing ciphertext throws relay-error rather than returning undefined", async () => {
    const { fetchFn } = singleRouteFetch({ status: 200, body: JSON.stringify({ ciphertext: 123 }) });
    const client = createRelayClient(fetchFn, BASE_URL);
    await expectUserActionableError(client.fetch(ID_HEX), "relay-error");
  });

  test("a 2xx body that isn't JSON throws relay-error", async () => {
    const { fetchFn } = singleRouteFetch({ status: 200, body: "garbage" });
    const client = createRelayClient(fetchFn, BASE_URL);
    await expectUserActionableError(client.fetch(ID_HEX), "relay-error");
  });

  test("a non-opaque id (e.g. a handle passed by mistake) is rejected before any request is sent", async () => {
    const { fetchFn, calls } = singleRouteFetch({ status: 200, body: JSON.stringify({ ciphertext: "ct" }) });
    const client = createRelayClient(fetchFn, BASE_URL);
    await expectUserActionableError(client.fetch("alice"), "relay-error");
    expect(calls).toHaveLength(0);
  });
});

describe("redeem", () => {
  test("200 returns redeemed", async () => {
    const { fetchFn, calls } = singleRouteFetch({ status: 200, body: "" });
    const client = createRelayClient(fetchFn, BASE_URL);
    expect(await client.redeem(ID_HEX)).toBe("redeemed");
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/invites/${ID_HEX}/redeem`);
    expect(calls[0]!.method).toBe("POST");
  });

  test("409 returns already", async () => {
    const { fetchFn } = singleRouteFetch({ status: 409, body: "" });
    const client = createRelayClient(fetchFn, BASE_URL);
    expect(await client.redeem(ID_HEX)).toBe("already");
  });
});

describe("reply", () => {
  test("POSTs the blob to /v1/invites/:id/reply", async () => {
    const { fetchFn, calls } = singleRouteFetch({ status: 200, body: "" });
    const client = createRelayClient(fetchFn, BASE_URL);
    await client.reply(ID_HEX, "reply-blob");
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/invites/${ID_HEX}/reply`);
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ blob: "reply-blob" });
  });
});

describe("readReply", () => {
  test("sends Authorization: Bearer creatorSecret and returns the blob", async () => {
    const { fetchFn, calls } = singleRouteFetch({ status: 200, body: JSON.stringify({ blob: "reply-blob" }) });
    const client = createRelayClient(fetchFn, BASE_URL);
    const result = await client.readReply(ID_HEX, "creator-secret-xyz");
    expect(result).toEqual({ blob: "reply-blob" });
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/invites/${ID_HEX}/reply`);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer creator-secret-xyz");
  });

  test("a 2xx body missing blob throws relay-error rather than returning undefined", async () => {
    const { fetchFn } = singleRouteFetch({ status: 200, body: JSON.stringify({ blob: 123 }) });
    const client = createRelayClient(fetchFn, BASE_URL);
    await expectUserActionableError(client.readReply(ID_HEX, "creator-secret-xyz"), "relay-error");
  });

  test("a 2xx body that isn't JSON throws relay-error", async () => {
    const { fetchFn } = singleRouteFetch({ status: 200, body: "garbage" });
    const client = createRelayClient(fetchFn, BASE_URL);
    await expectUserActionableError(client.readReply(ID_HEX, "creator-secret-xyz"), "relay-error");
  });

  test("404 reads as none", async () => {
    const { fetchFn } = singleRouteFetch({ status: 404, body: "" });
    const client = createRelayClient(fetchFn, BASE_URL);
    expect(await client.readReply(ID_HEX, "creator-secret-xyz")).toBe("none");
  });
});

describe("delete", () => {
  test("DELETEs with the Bearer creatorSecret", async () => {
    const { fetchFn, calls } = singleRouteFetch({ status: 200, body: "" });
    const client = createRelayClient(fetchFn, BASE_URL);
    await client.delete(ID_HEX, "creator-secret-xyz");
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/invites/${ID_HEX}`);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer creator-secret-xyz");
  });

  test("404 (already gone) is treated as success — revocation is idempotent", async () => {
    const { fetchFn } = singleRouteFetch({ status: 404, body: "" });
    const client = createRelayClient(fetchFn, BASE_URL);
    await expect(client.delete(ID_HEX, "creator-secret-xyz")).resolves.toBeUndefined();
  });
});

describe("opaque id enforcement", () => {
  const NOT_AN_OPAQUE_ID = "alice";

  test("every id-taking verb rejects a non-opaque id before sending a request", async () => {
    const { fetchFn, calls } = singleRouteFetch({ status: 200, body: JSON.stringify({ ciphertext: "ct", blob: "b" }) });
    const client = createRelayClient(fetchFn, BASE_URL);

    await expectUserActionableError(client.fetch(NOT_AN_OPAQUE_ID), "relay-error");
    await expectUserActionableError(client.redeem(NOT_AN_OPAQUE_ID), "relay-error");
    await expectUserActionableError(client.reply(NOT_AN_OPAQUE_ID, "blob"), "relay-error");
    await expectUserActionableError(client.readReply(NOT_AN_OPAQUE_ID, "secret"), "relay-error");
    await expectUserActionableError(client.delete(NOT_AN_OPAQUE_ID, "secret"), "relay-error");
    expect(calls).toHaveLength(0);
  });

  test("an uppercase-hex id is rejected (the client normalizes nothing)", async () => {
    const { fetchFn } = singleRouteFetch({ status: 200, body: JSON.stringify({ ciphertext: "ct" }) });
    const client = createRelayClient(fetchFn, BASE_URL);
    await expectUserActionableError(client.fetch(ID_HEX.toUpperCase()), "relay-error");
  });
});

describe("error mapping", () => {
  test("an unlisted non-2xx status throws relay-error naming the status and path", async () => {
    const { fetchFn } = singleRouteFetch({ status: 500, body: "" });
    const client = createRelayClient(fetchFn, BASE_URL);
    let caught: unknown;
    try {
      await client.fetch(ID_HEX);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UserActionableError);
    expect((caught as UserActionableError).code).toBe("relay-error");
    expect((caught as UserActionableError).message).toBe(`500 /v1/invites/${ID_HEX}`);
  });

  test("every write/read verb maps an unlisted non-2xx to relay-error", async () => {
    const { fetchFn } = singleRouteFetch({ status: 503, body: "" });
    const client = createRelayClient(fetchFn, BASE_URL);
    await expectUserActionableError(client.create("ct", "2026-09-01T00:00:00.000Z"), "relay-error");
    await expectUserActionableError(client.fetch(ID_HEX), "relay-error");
    await expectUserActionableError(client.redeem(ID_HEX), "relay-error");
    await expectUserActionableError(client.reply(ID_HEX, "blob"), "relay-error");
    await expectUserActionableError(client.readReply(ID_HEX, "secret"), "relay-error");
    await expectUserActionableError(client.delete(ID_HEX, "secret"), "relay-error");
  });

  test("status 0 (unreachable) throws relay-unreachable, never relay-error, on every verb", async () => {
    const { fetchFn } = singleRouteFetch({ status: 0, body: "" });
    const client = createRelayClient(fetchFn, BASE_URL);
    await expectUserActionableError(client.create("ct", "2026-09-01T00:00:00.000Z"), "relay-unreachable");
    await expectUserActionableError(client.fetch(ID_HEX), "relay-unreachable");
    await expectUserActionableError(client.redeem(ID_HEX), "relay-unreachable");
    await expectUserActionableError(client.reply(ID_HEX, "blob"), "relay-unreachable");
    await expectUserActionableError(client.readReply(ID_HEX, "secret"), "relay-unreachable");
    await expectUserActionableError(client.delete(ID_HEX, "secret"), "relay-unreachable");
  });

  test("relay-unreachable never reveals the request path or a secret", async () => {
    const { fetchFn } = singleRouteFetch({ status: 0, body: "" });
    const client = createRelayClient(fetchFn, BASE_URL);
    let caught: unknown;
    try {
      await client.readReply(ID_HEX, "top-secret-value");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UserActionableError);
    expect((caught as UserActionableError).message).not.toContain("top-secret-value");
    expect((caught as UserActionableError).message).not.toContain(ID_HEX);
  });
});

describe("timeouts", () => {
  test("every request carries a timeoutMs", async () => {
    const timeouts: (number | undefined)[] = [];
    const responseBodies: Record<string, string> = {
      [`${BASE_URL}/v1/invites`]: JSON.stringify({ id: ID_HEX, creatorSecret: "s" }),
      [`${BASE_URL}/v1/invites/${ID_HEX}`]: JSON.stringify({ ciphertext: "ct" }),
    };
    const fetchFn: Probes["fetch"] = async (url, init) => {
      timeouts.push(init?.timeoutMs);
      return { status: 200, body: responseBodies[url] ?? "", headers: {} };
    };
    const client = createRelayClient(fetchFn, BASE_URL);
    await client.create("ct", "2026-09-01T00:00:00.000Z");
    await client.fetch(ID_HEX);
    for (const t of timeouts) {
      expect(typeof t).toBe("number");
      expect(t).toBeGreaterThan(0);
    }
  });
});

describe("invariant: relay traffic never carries plaintext", () => {
  test("sealing a pointer with distinctive plaintext strings, none of those strings ever appear in any captured request", async () => {
    const idHex = ID_HEX;
    const key = generateKey();
    const pointer: InvitePointer = {
      v: 1,
      team: "SENTINEL-TEAM-9f3a",
      name: "Sentinel Display Name",
      remote: "git@github.com:sentinel-org/sentinel-repo.git",
      owner: "sentinel-owner-handle",
      forge: "github",
      createdAt: "2026-08-21T00:00:00.000Z",
    };
    const plaintextSubstrings = [pointer.team, pointer.name, pointer.remote, pointer.owner];

    const ciphertext = await seal(pointer, key, idHex);
    const reply = { v: 1 as const, agePublicKey: "age1qsentinelpublickeyexample", handle: "sentinel-owner-handle" };
    const replyBlob = await sealReply(reply, key, idHex);
    const creatorSecret = "creator-secret-do-not-leak";

    const { fetchFn, calls } = recordingFetch((call) => {
      if (call.method === "POST" && call.url === `${BASE_URL}/v1/invites`) {
        return { status: 200, body: JSON.stringify({ id: idHex, creatorSecret }) };
      }
      if (call.method === "GET" && call.url === `${BASE_URL}/v1/invites/${idHex}`) {
        return { status: 200, body: JSON.stringify({ ciphertext }) };
      }
      if (call.method === "POST" && call.url === `${BASE_URL}/v1/invites/${idHex}/redeem`) {
        return { status: 200, body: "" };
      }
      if (call.method === "POST" && call.url === `${BASE_URL}/v1/invites/${idHex}/reply`) {
        return { status: 200, body: "" };
      }
      if (call.method === "GET" && call.url === `${BASE_URL}/v1/invites/${idHex}/reply`) {
        return { status: 200, body: JSON.stringify({ blob: replyBlob }) };
      }
      if (call.method === "DELETE" && call.url === `${BASE_URL}/v1/invites/${idHex}`) {
        return { status: 200, body: "" };
      }
      return { status: 500, body: "" };
    });

    const client = createRelayClient(fetchFn, BASE_URL);
    await client.create(ciphertext, "2026-09-01T00:00:00.000Z");
    await client.fetch(idHex);
    await client.redeem(idHex);
    await client.reply(idHex, replyBlob);
    await client.readReply(idHex, creatorSecret);
    await client.delete(idHex, creatorSecret);

    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const call of calls) {
      const haystacks = [call.url, call.body ?? "", ...Object.values(call.headers)];
      for (const haystack of haystacks) {
        for (const secret of plaintextSubstrings) {
          expect(haystack).not.toContain(secret);
        }
      }
    }
  });
});
