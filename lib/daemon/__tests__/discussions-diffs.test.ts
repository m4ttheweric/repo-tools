/**
 * discussions:diffs (S053 + S086): the outbound GitLab fetch must carry a
 * bound signal (so a stalled connection doesn't orphan the promise and the
 * sops-decrypted token in its closure forever), and a full page (100 rows)
 * must be reported as `truncated` rather than silently dropped.
 */
import { expect, test } from "bun:test";
import { fetchMrDiffs } from "../handlers/discussions.ts";

function fakeDiffs(n: number) {
  return Array.from({ length: n }, (_, i) => ({ new_path: `file${i}.ts`, diff: `@@ diff ${i}` }));
}

test("truncated is false when fewer than a full page comes back", async () => {
  const fetchFn = (async () => new Response(JSON.stringify(fakeDiffs(3)), { status: 200 })) as typeof fetch;
  const out = await fetchMrDiffs("https://gitlab.example.com", "g/repo", 7, "tok", { fetchFn });
  expect(out.diffs).toHaveLength(3);
  expect(out.truncated).toBe(false);
});

test("truncated is true when exactly a full page (100) comes back", async () => {
  const fetchFn = (async () => new Response(JSON.stringify(fakeDiffs(100)), { status: 200 })) as typeof fetch;
  const out = await fetchMrDiffs("https://gitlab.example.com", "g/repo", 7, "tok", { fetchFn });
  expect(out.diffs).toHaveLength(100);
  expect(out.truncated).toBe(true);
});

test("maps new_path/diff to newPath/diff", async () => {
  const fetchFn = (async () => new Response(JSON.stringify([{ new_path: "a.ts", diff: "@@" }]), { status: 200 })) as typeof fetch;
  const out = await fetchMrDiffs("https://gitlab.example.com", "g/repo", 7, "tok", { fetchFn });
  expect(out.diffs).toEqual([{ newPath: "a.ts", diff: "@@" }]);
});

test("a non-ok response throws with the status", async () => {
  const fetchFn = (async () => new Response("", { status: 502 })) as typeof fetch;
  await expect(fetchMrDiffs("https://gitlab.example.com", "g/repo", 7, "tok", { fetchFn })).rejects.toThrow(/502/);
});

test("the fetch call carries an AbortSignal", async () => {
  let sawSignal: AbortSignal | undefined;
  const fetchFn = (async (_url: any, init: any) => {
    sawSignal = init?.signal;
    return new Response(JSON.stringify([]), { status: 200 });
  }) as typeof fetch;
  await fetchMrDiffs("https://gitlab.example.com", "g/repo", 7, "tok", { fetchFn });
  expect(sawSignal).toBeInstanceOf(AbortSignal);
});

test("aborting the caller's own request signal cancels the in-flight fetch", async () => {
  const controller = new AbortController();
  let sawSignal: AbortSignal | undefined;
  const fetchFn = (async (_url: any, init: any) => {
    sawSignal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }) as typeof fetch;
  const promise = fetchMrDiffs("https://gitlab.example.com", "g/repo", 7, "tok", { fetchFn, reqSignal: controller.signal });
  controller.abort();
  await expect(promise).rejects.toThrow();
  expect(sawSignal?.aborted).toBe(true);
});
