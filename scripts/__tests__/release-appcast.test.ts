import { describe, test, expect } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import {
  mkdtempSync, mkdirSync, rmSync, cpSync, copyFileSync, writeFileSync,
  chmodSync, existsSync, readFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";

// This suite proves appcast.sh's signing wiring end to end, offline, without
// ever touching the Keychain: a throwaway EdDSA key is derived purely from
// `openssl genpkey`, no `generate_keys` involved. It does NOT prove the
// production SPARKLE_ED_KEY works — a Keychain-issued key can only be
// exercised at a real tagged release.

const ROOT = join(import.meta.dir, "..", "..");
const SPARKLE_BIN = join(ROOT, "rt-tray", "deps", "tools", "sparkle", "bin");
const GEN = join(SPARKLE_BIN, "generate_appcast");
const SIGN = join(SPARKLE_BIN, "sign_update");
const MAKE_ZIP = join(ROOT, "scripts", "release", "make-zip.sh");
const APPCAST_SH = join(ROOT, "scripts", "release", "appcast.sh");
const DEV_APP = join(ROOT, "rt-tray", "mattstack-dev.app");

const HAVE_SPARKLE = existsSync(GEN) && existsSync(SIGN);
if (!HAVE_SPARKLE) {
  console.warn(`release-appcast.test.ts: skipped — ${GEN} missing (run scripts/fetch-deps.sh)`);
}

// Pulls a labelled hex block ("priv:" / "pub:") out of `openssl pkey -text`
// output, e.g.:
//   priv:
//       3c:91:...:
//       ...
//   pub:
function extractHexBlock(text: string, label: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === label);
  if (start === -1) throw new Error(`openssl -text output missing "${label}" block`);
  const hex: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/^\s+[0-9a-f:]+$/.test(line)) break;
    hex.push(line);
  }
  return hex.join("").replace(/[:\s]/g, "");
}

// Derives a throwaway Sparkle-compatible EdDSA key entirely offline: a raw
// ed25519 keypair from `openssl genpkey`, expanded to the 96-byte
// a‖prefix‖pub form generate_appcast/sign_update require (a = clamp(SHA512(seed)[0:32]),
// prefix = SHA512(seed)[32:64]) — never touches the Keychain or `generate_keys`.
function deriveThrowawayKey(workdir: string): { sparkleEdKey: string; publicKeyB64: string } {
  const privPem = join(workdir, "priv.pem");
  const pubPem = join(workdir, "pub.pem");
  execFileSync("openssl", ["genpkey", "-algorithm", "ed25519", "-out", privPem]);
  execFileSync("openssl", ["pkey", "-in", privPem, "-pubout", "-out", pubPem]);
  const privText = execFileSync("openssl", ["pkey", "-in", privPem, "-text", "-noout"]).toString();
  const pubText = execFileSync("openssl", ["pkey", "-in", pubPem, "-pubin", "-text", "-noout"]).toString();

  const seed = Buffer.from(extractHexBlock(privText, "priv:"), "hex");
  const pub = Buffer.from(extractHexBlock(pubText, "pub:"), "hex");
  expect(seed.length).toBe(32);
  expect(pub.length).toBe(32);

  const h = createHash("sha512").update(seed).digest();
  const a = Buffer.from(h.subarray(0, 32));
  a[0] = (a[0] ?? 0) & 248;
  a[31] = ((a[31] ?? 0) & 127) | 64;
  const prefix = h.subarray(32, 64);

  return {
    sparkleEdKey: Buffer.concat([a, prefix, pub]).toString("base64"),
    publicKeyB64: pub.toString("base64"),
  };
}

const MINIMAL_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>mattstack-fixture</string>
    <key>CFBundleIdentifier</key>
    <string>com.mattstack.release-fixture</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
</dict>
</plist>
`;

// Copies mattstack-dev.app when it's been built locally; otherwise assembles
// a minimal but genuinely signable bundle (a real Mach-O + a plist) so
// codesign and generate_appcast's own signing-identity check both succeed.
function buildFixtureApp(workdir: string): string {
  const appPath = join(workdir, "mattstack-fixture.app");
  if (existsSync(DEV_APP)) {
    cpSync(DEV_APP, appPath, { recursive: true });
  } else {
    mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
    copyFileSync("/bin/echo", join(appPath, "Contents", "MacOS", "mattstack-fixture"));
    chmodSync(join(appPath, "Contents", "MacOS", "mattstack-fixture"), 0o755);
    writeFileSync(join(appPath, "Contents", "Info.plist"), MINIMAL_PLIST);
  }
  return appPath;
}

function stampPublicKeyAndSign(appPath: string, publicKeyValue: string): void {
  const plist = join(appPath, "Contents", "Info.plist");
  const setResult = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Set :SUPublicEDKey ${publicKeyValue}`, plist]);
  if (setResult.status !== 0) {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :SUPublicEDKey string ${publicKeyValue}`, plist]);
  }
  execFileSync("codesign", ["--force", "--deep", "-s", "-", appPath]);
}

// A curl that always reports "not found" (curl -f's exit 22) — exercises
// appcast.sh's first-release branch without any real network access.
function writeCurl404Shim(binDir: string): void {
  writeFileSync(join(binDir, "curl"), "#!/bin/bash\nexit 22\n");
  chmodSync(join(binDir, "curl"), 0o755);
}

function runAppcastSh(archivesDir: string, tag: string, sparkleEdKey: string, fakeBin: string) {
  return spawnSync("bash", [APPCAST_SH, archivesDir, tag], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, SPARKLE_ED_KEY: sparkleEdKey, GITHUB_REPOSITORY: "m4ttstack/rt" },
    encoding: "utf8",
  });
}

describe.skipIf(!HAVE_SPARKLE)("appcast.sh signing (offline, throwaway key)", () => {
  test("signs the new enclosure, and the embedded signature matches an independent sign_update run", () => {
    const workdir = mkdtempSync(join(tmpdir(), "mattstack-release-appcast-"));
    try {
      const { sparkleEdKey, publicKeyB64 } = deriveThrowawayKey(workdir);

      const appPath = buildFixtureApp(workdir);
      stampPublicKeyAndSign(appPath, publicKeyB64);

      const archivesDir = join(workdir, "archives");
      mkdirSync(archivesDir);
      const zipPath = join(archivesDir, "mattstack-1.0.0.zip");
      execFileSync("bash", [MAKE_ZIP, appPath, zipPath]);

      const fakeBin = join(workdir, "fakebin");
      mkdirSync(fakeBin);
      writeCurl404Shim(fakeBin);

      const result = runAppcastSh(archivesDir, "v1.0.0", sparkleEdKey, fakeBin);
      expect(result.status).toBe(0);

      const appcastXml = readFileSync(join(archivesDir, "appcast.xml"), "utf8");
      const enclosureLine = appcastXml.split("\n").find((l) => l.includes("<enclosure") && l.includes("mattstack-1.0.0.zip"));
      expect(enclosureLine).toBeDefined();
      const embeddedSig = enclosureLine!.match(/sparkle:edSignature="([^"]+)"/)?.[1];
      expect(embeddedSig).toBeTruthy();

      const independentSig = execFileSync(SIGN, ["--ed-key-file", "-", "-p", zipPath], { input: sparkleEdKey }).toString().trim();
      expect(embeddedSig).toBe(independentSig);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("fails with a named reason when SUPublicEDKey is the unfilled template placeholder", () => {
    const workdir = mkdtempSync(join(tmpdir(), "mattstack-release-appcast-badkey-"));
    try {
      const { sparkleEdKey } = deriveThrowawayKey(workdir);

      const appPath = buildFixtureApp(workdir);
      // generate_appcast exits 0 and silently omits edSignature for this
      // exact case — appcast.sh must not let a mismatched key ship silently.
      stampPublicKeyAndSign(appPath, "REPLACE_WITH_RELEASE_PUBLIC_ED_KEY");

      const archivesDir = join(workdir, "archives");
      mkdirSync(archivesDir);
      const zipPath = join(archivesDir, "mattstack-1.0.0.zip");
      execFileSync("bash", [MAKE_ZIP, appPath, zipPath]);

      const fakeBin = join(workdir, "fakebin");
      mkdirSync(fakeBin);
      writeCurl404Shim(fakeBin);

      const result = runAppcastSh(archivesDir, "v1.0.0", sparkleEdKey, fakeBin);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/edSignature|does not match/);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
