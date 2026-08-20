import { currentMode } from "../lib/dev-mode.ts";
import { bold, cyan, dim, green, reset, yellow } from "../lib/tui.ts";

declare const RT_VERSION: string;

export async function runVersion(_args: string[]): Promise<void> {
  const version = (typeof RT_VERSION !== "undefined" ? RT_VERSION : null) ?? process.env.RT_VERSION ?? "dev";

  console.log(`\n  ${bold}${cyan}rt${reset}  ${version}`);

  if (currentMode() === "dev") {
    console.log(`  ${yellow}dev mode${reset}  ${dim}running from local source — switch with: rt settings dev-mode${reset}`);
  } else {
    console.log(`  ${green}prod${reset}  ${dim}${process.execPath}${reset}`);
  }

  console.log("");
}
