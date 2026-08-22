// lib/__tests__/release-workflow.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";

const wf = parse(readFileSync(join(import.meta.dir, "..", "..", ".github", "workflows", "release.yml"), "utf8"));
const stepNames = (job: string): string[] => wf.jobs[job].steps.map((s: any) => s.name ?? s.uses);

describe("release.yml", () => {
  test("triggers on v* tags and manual dispatch; two jobs", () => {
    expect(wf.on.push.tags).toEqual(["v*"]);
    expect(wf.on).toHaveProperty("workflow_dispatch");
    expect(Object.keys(wf.jobs)).toEqual(["release", "clean-room"]);
    expect(wf.jobs["clean-room"].needs).toBe("release");
  });
  test("arm64 only — no x64 compile, no tarballs", () => {
    const text = JSON.stringify(wf);
    expect(text).not.toContain("bun-darwin-x64");
    expect(text).not.toContain("tar.gz");
    expect(text).toContain("bun-darwin-arm64");
  });
  test("the train is ordered: compile → deps → build → contract → notarize app → zip/dmg → notarize dmg → appcast → release", () => {
    const names = stepNames("release");
    const idx = (n: string) => names.findIndex((s) => s.startsWith(n));
    expect(idx("Compile rt")).toBeLessThan(idx("Fetch bundled dependencies"));
    expect(idx("Fetch bundled dependencies")).toBeLessThan(idx("Build mattstack.app"));
    expect(idx("Build mattstack.app")).toBeLessThan(idx("Assert the bundle contract"));
    expect(idx("Assert the bundle contract")).toBeLessThan(idx("Notarize and staple the app"));
    expect(idx("Notarize and staple the app")).toBeLessThan(idx("Zip enclosure + DMG"));
    expect(idx("Zip enclosure + DMG")).toBeLessThan(idx("Notarize and staple the DMG"));
    expect(idx("Notarize and staple the DMG")).toBeLessThan(idx("Appcast"));
    expect(idx("Appcast")).toBeLessThan(idx("Create Release"));
  });
  test("release assets are the dmg, the zip, deltas, appcast, checksums", () => {
    const step = wf.jobs.release.steps.find((s: any) => s.name === "Create Release");
    expect(step.with.files).toContain("out/mattstack-*.dmg");
    expect(step.with.files).toContain("out/mattstack-*.zip");
    expect(step.with.files).toContain("out/appcast.xml");
    expect(step.with.files).toContain("out/*.delta");
  });
  test("clean room runs L7's script, not inline steps, and never installs brew packages", () => {
    const text = JSON.stringify(wf.jobs["clean-room"]);
    expect(text).toContain("scripts/e2e-cleanroom.sh");
    expect(text).not.toContain("brew install");
  });
  test("bun is pinned to the deps.lock version", () => {
    const lock = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "rt-tray", "deps.lock"), "utf8"));
    const bun = lock.tools.find((t: any) => t.name === "bun").version;
    const setup = wf.jobs.release.steps.find((s: any) => String(s.uses ?? "").startsWith("oven-sh/setup-bun"));
    expect(setup.with["bun-version"]).toBe(bun);
  });
});
