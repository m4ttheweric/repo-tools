// lib/__tests__/release-workflow.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";

const wf = parse(readFileSync(join(import.meta.dir, "..", "..", ".github", "workflows", "release.yml"), "utf8"));
const stepNames = (job: string): string[] => wf.jobs[job].steps.map((s: any) => s.name ?? s.uses);
const names = stepNames("release");
// findIndex returns -1 for an absent step, and -1 satisfies every
// toBeLessThan — assert presence before the caller compares order.
const idx = (n: string) => {
  const i = names.findIndex((s) => s.startsWith(n));
  expect(i).toBeGreaterThanOrEqual(0);
  return i;
};

describe("release.yml", () => {
  test("triggers on v* tags and manual dispatch; one job, arch-pinned", () => {
    expect(wf.on.push.tags).toEqual(["v*"]);
    expect(wf.on).toHaveProperty("workflow_dispatch");
    expect(Object.keys(wf.jobs)).toEqual(["release"]);
    expect(wf.jobs.release["runs-on"]).toBe("macos-15");
  });
  test("arm64 only — no x64 compile, no tarballs", () => {
    const text = JSON.stringify(wf);
    expect(text).not.toContain("bun-darwin-x64");
    expect(text).not.toContain("tar.gz");
    expect(text).toContain("bun-darwin-arm64");
  });
  test("the train is ordered: compile → deps → build → contract → version assert → notarize app → zip → clean-room → dmg → notarize dmg → appcast → checksums → release", () => {
    expect(idx("Compile rt")).toBeLessThan(idx("Fetch bundled dependencies"));
    expect(idx("Fetch bundled dependencies")).toBeLessThan(idx("Build mattstack.app"));
    expect(idx("Build mattstack.app")).toBeLessThan(idx("Assert the bundle contract"));
    expect(idx("Assert the bundle contract")).toBeLessThan(idx("Assert tag matches the stamped version"));
    expect(idx("Assert tag matches the stamped version")).toBeLessThan(idx("Notarize and staple the app"));
    expect(idx("Notarize and staple the app")).toBeLessThan(idx("Make zip"));
    expect(idx("Make zip")).toBeLessThan(idx("Clean-room install + verify"));
    expect(idx("Clean-room install + verify")).toBeLessThan(idx("Make dmg"));
    expect(idx("Make dmg")).toBeLessThan(idx("Notarize and staple the dmg"));
    expect(idx("Notarize and staple the dmg")).toBeLessThan(idx("Appcast"));
    expect(idx("Appcast")).toBeLessThan(idx("Checksums"));
    expect(idx("Checksums")).toBeLessThan(idx("Assert release assets are complete"));
    expect(idx("Assert release assets are complete")).toBeLessThan(idx("Create Release"));
  });
  test("the clean-room gate runs inline, before dmg/notarize/appcast/publish, on every trigger (no if:)", () => {
    const step = wf.jobs.release.steps.find((s: any) => s.name === "Clean-room install + verify");
    expect(step.run).toContain("scripts/e2e-cleanroom.sh");
    expect(step.if).toBeUndefined();
    expect(JSON.stringify(wf.jobs.release)).not.toContain("brew install");
  });
  test("Appcast is not gated on publish — dry runs rehearse it too", () => {
    const step = wf.jobs.release.steps.find((s: any) => (s.name ?? "").startsWith("Appcast"));
    expect(step.if).toBeUndefined();
  });
  test("dispatch runs stamp a clean semver above the latest release, never the run-numbered tag, into RT_VERSION", () => {
    const build = wf.jobs.release.steps.find((s: any) => s.name === "Build mattstack.app");
    expect(build.env.RT_VERSION).toBe("${{ steps.meta.outputs.version }}");
    const meta = wf.jobs.release.steps.find((s: any) => s.name === "Release metadata");
    // A v0.0.0-ci rehearsal sorts below a real appcast item and generate_appcast
    // then writes no enclosure for it: the synthetic version patch-bumps the
    // latest published release instead, and reads it with the run's own token.
    expect(meta.run).toContain("releases/latest");
    expect(meta.run).toMatch(/VERSION="\$\{MAJ:-0\}\.\$\{MIN:-0\}\.\$\(\( \$\{PAT%%-\*\} \+ 1 \)\)"/);
    expect(meta.run).not.toContain('VERSION="0.0.0"');
    expect(meta.env.GH_TOKEN).toBe("${{ github.token }}");
    expect(meta.run).toContain('ARTIFACT_VERSION="${VERSION}-ci${GITHUB_RUN_NUMBER}"');
  });
  test("Checksums uses nullglob + working-directory: out, and never fails on an absent class", () => {
    const step = wf.jobs.release.steps.find((s: any) => s.name === "Checksums");
    expect(step["working-directory"]).toBe("out");
    expect(step.run).toContain("shopt -s nullglob");
    expect(step.run).not.toContain("cat out/SHA256SUMS");
  });
  test("the tag/version consistency assert exists and is skipped on dispatch", () => {
    const step = wf.jobs.release.steps.find((s: any) => s.name === "Assert tag matches the stamped version");
    expect(step.if).toBe("steps.meta.outputs.publish == 'true'");
    expect(step.run).toContain("CFBundleShortVersionString");
    expect(step.run).toContain("dist/rt --version");
  });
  test("RT_VSIX resolution is asserted, not silently empty", () => {
    const step = wf.jobs.release.steps.find((s: any) => s.name === "Build extension");
    expect(step.shell).toBe("bash");
    expect(step.run).toContain("no .vsix produced");
  });
  test("release assets are asserted present before Create Release, which stays lenient on deltas", () => {
    const guard = wf.jobs.release.steps.find((s: any) => s.name === "Assert release assets are complete");
    expect(guard.if).toBe("steps.meta.outputs.publish == 'true'");
    const step = wf.jobs.release.steps.find((s: any) => s.name === "Create Release");
    expect(step.with.fail_on_unmatched_files).toBe(false);
    expect(step.with.files).toContain("out/mattstack-*.dmg");
    expect(step.with.files).toContain("out/mattstack-*.zip");
    expect(step.with.files).toContain("out/appcast.xml");
    expect(step.with.files).toContain("out/*.delta");
  });
  test("the decoded p12 is cleaned up via trap, not a trailing rm that -e can skip", () => {
    const step = wf.jobs.release.steps.find((s: any) => s.name === "Import Developer ID certificate");
    expect(step.run).toContain("trap 'rm -f \"$CERT_PATH\"' EXIT");
  });
  test("permissions are job-scoped (not workflow-wide), concurrency is keyed on the ref, and install is frozen", () => {
    expect(wf.permissions).toBeUndefined();
    expect(wf.jobs.release.permissions).toEqual({ contents: "write" });
    expect(wf.concurrency.group).toBe("release-${{ github.ref }}");
    const install = wf.jobs.release.steps.find((s: any) => s.name === "Install dependencies");
    expect(install.run).toContain("--frozen-lockfile");
  });
  test("no RT_SANDBOX_PRESIGN escape hatch in CI", () => {
    expect(JSON.stringify(wf)).not.toContain("RT_SANDBOX_PRESIGN");
  });
  test("bun is pinned to the deps.lock version", () => {
    const lock = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "rt-tray", "deps.lock"), "utf8"));
    const bun = lock.tools.find((t: any) => t.name === "bun").version;
    const setup = wf.jobs.release.steps.find((s: any) => String(s.uses ?? "").startsWith("oven-sh/setup-bun"));
    expect(setup.with["bun-version"]).toBe(bun);
  });
});
