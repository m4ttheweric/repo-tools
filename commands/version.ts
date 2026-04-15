import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { bold, cyan, dim, green, reset, yellow } from "../lib/tui.ts";

declare const RT_VERSION: string;

export async function runVersion(_args: string[]): Promise<void> {
  const version = (typeof RT_VERSION !== "undefined" ? RT_VERSION : null) ?? process.env.RT_VERSION ?? "dev";
  const isDevMode = existsSync(join(homedir(), ".local/bin/rt"));

  console.log(`\n  ${bold}${cyan}rt${reset}  ${version}`);

  if (isDevMode) {
    console.log(`  ${yellow}dev mode${reset}  ${dim}running from local source — switch with: rt settings dev-mode${reset}`);
  } else {
    console.log(`  ${green}prod${reset}  ${dim}Homebrew install${reset}`);
  }

  console.log("");
}
