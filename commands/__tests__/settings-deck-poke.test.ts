import { describe, expect, test } from "bun:test";
import { pokeDeckReresolve } from "../settings.ts";

describe("pokeDeckReresolve", () => {
  test("summarizes a successful reresolve", async () => {
    const msg = await pokeDeckReresolve({
      readApiFile: () => JSON.stringify({ port: 4141 }),
      fetchImpl: (async () => Response.json({ restarted: ["chat"], unchanged: ["console"], failed: [] })) as typeof fetch,
    });
    expect(msg).toContain("1 restarted");
    expect(msg).toContain("1 unchanged");
  });
  test("degrades to a note when deck is not reachable", async () => {
    const msg = await pokeDeckReresolve({
      readApiFile: () => JSON.stringify({ port: 4141 }),
      fetchImpl: (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch,
    });
    expect(msg).toContain("not poked");
  });
  test("degrades when api.json is absent", async () => {
    expect(await pokeDeckReresolve({ readApiFile: () => null })).toContain("no api.json");
  });
  test("names failed apps", async () => {
    const msg = await pokeDeckReresolve({
      readApiFile: () => JSON.stringify({ port: 4141 }),
      fetchImpl: (async () => Response.json({ restarted: [], unchanged: [], failed: [{ name: "chat", error: "x" }] })) as typeof fetch,
    });
    expect(msg).toContain("chat");
  });
  test("degrades when reading api.json throws", async () => {
    const msg = await pokeDeckReresolve({
      readApiFile: () => { throw new Error("EACCES"); },
    });
    expect(msg).toContain("not poked");
  });

  // Failure paths that keep the toggle alive when deck is unreachable or answers badly.

  test("degrades when api.json is unparseable", async () => {
    const msg = await pokeDeckReresolve({ readApiFile: () => "{not json" });
    expect(msg).toContain("not poked");
  });

  test("degrades when api.json has no numeric port", async () => {
    const msg = await pokeDeckReresolve({ readApiFile: () => JSON.stringify({ port: "4141" }) });
    expect(msg).toContain("bad api.json");
  });

  test("degrades on a non-2xx answer", async () => {
    const msg = await pokeDeckReresolve({
      readApiFile: () => JSON.stringify({ port: 4141 }),
      fetchImpl: (async () => new Response("", { status: 500 })) as typeof fetch,
    });
    expect(msg).toContain("500");
  });

  test("degrades on a timeout", async () => {
    const msg = await pokeDeckReresolve({
      readApiFile: () => JSON.stringify({ port: 4141 }),
      fetchImpl: (async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }) as typeof fetch,
    });
    expect(msg).toContain("not poked");
  });
});
