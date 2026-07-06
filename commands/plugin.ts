/**
 * rt plugin (manage user plugins, ~/.rt/plugins).
 * Discovery/merge lives in lib/plugins.ts; these are the management verbs.
 */

import { spawnSync } from "child_process";
import { bold, cyan, dim, green, reset, yellow } from "../lib/tui.ts";
import { scaffoldPlugin } from "../lib/plugins.ts";
import type { CommandContext } from "../lib/command-tree.ts";

export async function runNew(args: string[], _ctx: CommandContext): Promise<void> {
  let name = args[0];
  if (!name && process.stdin.isTTY) {
    const { textInput } = await import("../lib/rt-render.tsx");
    name = await textInput({ message: "Plugin name (kebab-case)", placeholder: "my-plugin" });
  }
  if (!name) {
    console.error(`\n  ${yellow}usage: rt plugin new <name>${reset}\n`);
    process.exit(1);
  }

  const dir = scaffoldPlugin(name);
  console.log(`\n  ${green}created${reset} ${dir}\n`);

  const pm = Bun.which("bun") ? "bun" : Bun.which("npm") ? "npm" : null;
  if (pm) {
    const result = spawnSync(pm, ["install"], { cwd: dir, stdio: "inherit" });
    if (result.status !== 0) console.error(`  ${yellow}${pm} install failed; run it manually in ${dir}${reset}`);
  } else {
    console.log(`  ${dim}no bun/npm on PATH; for IDE types run 'bun install' in ${dir}${reset}`);
  }

  console.log(`\n  ${bold}next steps${reset}`);
  console.log(`  ${dim}edit${reset}  ${dir}/${name}.ts`);
  console.log(`  ${dim}run${reset}   ${cyan}rt ${name}${reset}\n`);
}

export async function runList(): Promise<void> {
  console.log("  (implemented in the next commit)");
}
export async function runValidate(): Promise<void> {
  console.log("  (implemented in the next commit)");
}
