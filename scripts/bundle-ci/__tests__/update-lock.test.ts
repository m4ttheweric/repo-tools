import { expect, test } from "bun:test";
import { applyBuildResults } from "../update-lock.ts";
import { parseDepsLock } from "../../../lib/bundle-layout.ts";

const LOCK = `{
  "schema": 1,
  "arch": "arm64",
  "tools": [
    { "name": "deck", "version": "", "license": "MIT", "repo": "m4ttstack/deck", "url": "", "sha256": "",
      "archive": "raw", "extract": "", "bundlePath": "Contents/Helpers/deck", "exec": ["Contents/Helpers/deck"],
      "exposeByDefault": true, "entitlements": "jit", "status": "pending", "kind": "helper" },
    { "name": "gitq", "version": "0.2.1", "license": "MIT", "repo": "m4ttstack/gitq",
      "url": "https://github.com/m4ttstack/gitq/releases/download/v0.2.1/gitq-darwin-arm64",
      "sha256": "${"c".repeat(64)}",
      "archive": "raw", "extract": "", "bundlePath": "Contents/Helpers/gitq",
      "exec": ["Contents/Helpers/gitq"],
      "exposeByDefault": true, "entitlements": "jit", "status": "bundled", "kind": "helper" }
  ]
}
`;

const RESULT = {
  name: "deck", version: "0.5.0",
  url: "https://github.com/m4ttstack/deck/releases/download/v0.5.0/deck-darwin-arm64.tgz",
  sha256: "d".repeat(64),
};

test("rewrites the named row to the pinned tarball shape", () => {
  const out = applyBuildResults(LOCK, [RESULT]);
  const deck = parseDepsLock(out).tools.find((t) => t.name === "deck")!;
  expect(deck.version).toBe("0.5.0");
  expect(deck.url).toBe(RESULT.url);
  expect(deck.sha256).toBe(RESULT.sha256);
  expect(deck.status).toBe("bundled");
  expect(deck.archive).toBe("tar.gz");
  expect(deck.extract).toBe("deck");
});

test("untouched rows keep their exact bytes", () => {
  const out = applyBuildResults(LOCK, [RESULT]);
  const gitqBlockBefore = LOCK.slice(LOCK.indexOf(`"name": "gitq"`));
  const gitqBlockAfter = out.slice(out.indexOf(`"name": "gitq"`));
  expect(gitqBlockAfter).toBe(gitqBlockBefore);
});

test("a value containing regex replacement patterns is written literally", () => {
  const out = applyBuildResults(LOCK, [{ ...RESULT, version: "1.0.0-$&x" }]);
  expect(parseDepsLock(out).tools.find((t) => t.name === "deck")!.version).toBe("1.0.0-$&x");
});

test("unknown app throws and changes nothing", () => {
  expect(() => applyBuildResults(LOCK, [{ ...RESULT, name: "nope" }])).toThrow(/nope/);
});

test("result that would not re-parse throws", () => {
  expect(() => applyBuildResults(LOCK, [{ ...RESULT, sha256: "tooshort" }])).toThrow();
});

test("a brace inside a quoted value does not truncate the row span", () => {
  const braced = LOCK.replace('"license": "MIT"', '"license": "MIT {see LICENSE}"');
  const out = applyBuildResults(braced, [RESULT]);
  const deck = parseDepsLock(out).tools.find((t) => t.name === "deck")!;
  expect(deck.version).toBe("0.5.0");
  expect(deck.license).toBe("MIT {see LICENSE}");
});
