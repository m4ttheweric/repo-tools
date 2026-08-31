import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readBundleRecipe } from "../validate-manifest.ts";

function manifest(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "manifest-"));
  const path = join(dir, "mattstack.deck.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

test("valid manifest returns the recipe", () => {
  const p = manifest({ name: "deck", bundle: { build: "bun run compile", artifact: "dist/deck" } });
  expect(readBundleRecipe(p)).toEqual({ name: "deck", build: "bun run compile", artifact: "dist/deck" });
});

test("missing file throws with the path", () => {
  expect(() => readBundleRecipe("/nonexistent/mattstack.deck.json")).toThrow(/mattstack\.deck\.json/);
});

test("a non-ENOENT read failure surfaces as itself, not as a missing manifest", () => {
  // A directory read fails EISDIR; the owner must not be told to add a file.
  expect(() => readBundleRecipe(mkdtempSync(join(tmpdir(), "notafile-")))).toThrow(/EISDIR|illegal operation/i);
});

test("unparsable JSON throws", () => {
  expect(() => readBundleRecipe(manifest("{nope"))).toThrow();
});

test("missing bundle node names the remediation", () => {
  expect(() => readBundleRecipe(manifest({ name: "deck" }))).toThrow(/bundle\.build \+ bundle\.artifact/);
});

test("non-string build rejected", () => {
  expect(() => readBundleRecipe(manifest({ name: "deck", bundle: { build: 7, artifact: "dist/deck" } }))).toThrow(/bundle\.build/);
});

test("missing artifact rejected", () => {
  expect(() => readBundleRecipe(manifest({ name: "deck", bundle: { build: "x" } }))).toThrow(/bundle\.artifact/);
});

test("absolute or ..-escaping artifact rejected", () => {
  expect(() => readBundleRecipe(manifest({ name: "deck", bundle: { build: "x", artifact: "/etc/passwd" } }))).toThrow(/artifact/);
  expect(() => readBundleRecipe(manifest({ name: "deck", bundle: { build: "x", artifact: "../out" } }))).toThrow(/artifact/);
});

test("missing name rejected", () => {
  expect(() => readBundleRecipe(manifest({ bundle: { build: "x", artifact: "dist/x" } }))).toThrow(/name/);
});

test("control characters in build or artifact rejected", () => {
  expect(() =>
    readBundleRecipe(manifest({ name: "deck", bundle: { build: "a\nb", artifact: "dist/deck" } })),
  ).toThrow(/control characters/);
  expect(() =>
    readBundleRecipe(manifest({ name: "deck", bundle: { build: "x", artifact: "dist/\tdeck" } })),
  ).toThrow(/control characters/);
});
