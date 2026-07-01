import { existsSync } from "fs";
import { RT_BINARY } from "./harness.ts";

if (!process.env.RT_BINARY && !existsSync(RT_BINARY)) {
  console.log("e2e: building rt binary...");
  const proc = Bun.spawnSync([
    "bun", "build", "--compile",
    "./cli.ts",
    "--outfile", RT_BINARY,
    "--define", 'RT_VERSION="e2e-test"',
  ], {
    cwd: import.meta.dir.replace("/e2e", ""),
    stdout: "inherit",
    stderr: "inherit",
  });

  if (proc.exitCode !== 0) {
    console.error("e2e: failed to build rt binary");
    process.exit(1);
  }

  Bun.spawnSync([
    "codesign", "--remove-signature", RT_BINARY,
  ]);
  Bun.spawnSync([
    "codesign", "--force", "--sign", "-",
    "--entitlements", import.meta.dir.replace("/e2e", "/scripts/entitlements.plist"),
    RT_BINARY,
  ]);

  console.log("e2e: binary built and signed at", RT_BINARY);
}
