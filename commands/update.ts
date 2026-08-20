#!/usr/bin/env bun

/**
 * rt update — install the latest GitHub release.
 *
 * Downloads the release tarball (the same artifact mattstack.app ships in),
 * then runs the EXTRACTED binary's --post-install so the rt binary, the app
 * bundle, and the editor extension are installed by the one code path a fresh
 * install uses. Nothing here knows how to install; post-install does.
 */

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { currentMode } from "../lib/dev-mode.ts";
import { rtDir } from "../lib/rt-paths.ts";
import { bold, dim, green, red, reset, yellow } from "../lib/tui.ts";

declare const RT_VERSION: string;

export const RELEASES_API = "https://api.github.com/repos/m4ttstack/rt/releases/latest";

interface ReleaseAsset { name: string; browser_download_url: string }
interface Release { tag_name: string; assets: ReleaseAsset[] }

export function releaseAssetName(tag: string, arch: string = process.arch): string {
  return `rt-darwin-${arch === "arm64" ? "arm64" : "x64"}-${tag}.tar.gz`;
}

function stripV(v: string): string {
  return v.startsWith("v") ? v.slice(1) : v;
}

export async function runUpdate(_args: string[]): Promise<void> {
  if (currentMode() === "dev") {
    console.log(`\n  ${yellow}⚠${reset}  dev mode is active — you're running from local source.`);
    console.log(`  ${dim}Switch to prod first: rt settings dev-mode prod${reset}\n`);
    process.exit(1);
  }

  // RT_VERSION is injected at compile time via bun build --define.
  const current = (typeof RT_VERSION !== "undefined" ? RT_VERSION : null) ?? process.env.RT_VERSION ?? "dev";
  console.log(`  ${dim}current: ${current}${reset}`);

  let release: Release;
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    release = (await res.json()) as Release;
  } catch (err: any) {
    console.log(`\n  ${red}✗${reset}  could not check releases: ${err?.message ?? err}\n`);
    process.exit(1);
  }

  const tag = release.tag_name;
  if (stripV(tag) === stripV(current)) {
    console.log(`  ${green}✓${reset}  already up to date\n`);
    return;
  }

  const assetName = releaseAssetName(tag);
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    console.log(`\n  ${red}✗${reset}  release ${tag} has no ${assetName}\n`);
    process.exit(1);
  }

  console.log(`  ${dim}latest:  ${tag}${reset}\n`);
  console.log(`  downloading ${bold}${assetName}${reset}…`);

  const stage = join(rtDir(), "updates", tag);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const tarball = join(stage, assetName);

  try {
    const res = await fetch(asset.browser_download_url);
    if (!res.ok) throw new Error(`download ${res.status}`);
    await Bun.write(tarball, res);
  } catch (err: any) {
    console.log(`\n  ${red}✗${reset}  download failed: ${err?.message ?? err}\n`);
    process.exit(1);
  }

  const untar = spawnSync("tar", ["-xzf", tarball, "-C", stage], { stdio: "pipe", env: process.env });
  if (untar.status !== 0) {
    console.log(`\n  ${red}✗${reset}  extract failed: ${untar.stderr?.toString().trim()}\n`);
    process.exit(1);
  }

  const newRt = join(stage, "rt");
  if (!existsSync(newRt)) {
    console.log(`\n  ${red}✗${reset}  tarball has no rt binary\n`);
    process.exit(1);
  }

  console.log(`\n  running post-install from ${tag}…\n`);
  const post = spawnSync(newRt, ["--post-install"], {
    stdio: "inherit",
    env: { ...process.env, RT_SKIP_SETUP: "1" },
  });
  if (post.status !== 0) {
    console.log(`\n  ${red}✗${reset}  post-install failed — the extracted release is at ${stage}\n`);
    process.exit(1);
  }

  rmSync(stage, { recursive: true, force: true });
  console.log(`\n  ${green}✓${reset}  rt updated to ${tag} — restart your terminal for the new version\n`);
}
