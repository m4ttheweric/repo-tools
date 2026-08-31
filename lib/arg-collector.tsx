import { spawnSync } from "child_process";
import type { CommandArg } from "./command-tree.ts";
import { T, toAnsiFg, toHex } from "./tui/palette.ts";

export async function collectArgs(
  label: string,
  argDefs: CommandArg[],
): Promise<string[] | null> {
  if (!argDefs.length) return [];

  const { ensureFzf } = await import("./fzf.ts");
  ensureFzf();

  // Step 1: multi-select which args to include
  const labelWidth = Math.max(...argDefs.map((a) => (a.flag ?? a.name).length));
  const input = argDefs
    .map((arg) => {
      const display = arg.flag ?? arg.name;
      const pad = " ".repeat(labelWidth - display.length);
      const hint = arg.hint ? `\x1b[2m${arg.hint}\x1b[22m` : "";
      return `${arg.name}\t\x1b[1m${display}\x1b[22m${pad}  ${hint}`;
    })
    .join("\n");

  const result = spawnSync("fzf", [
    "--multi",
    "--ansi",
    "--with-nth=2..",
    "--delimiter=\t",
    "--layout=reverse",
    "--border=left",
    "--no-separator",
    "--prompt=  filter: ",
    `--header=${toAnsiFg(T.pink)}${label} args\x1b[0m`,
    "--header-first",
    "--info=inline-right",
    "--footer=space: toggle  tab: toggle & next  enter: confirm",
    "--no-mouse",
    "--bind=space:toggle,tab:toggle+down",
    `--color=border:${toHex(T.pink)}`,
  ], {
    input,
    stdio: ["pipe", "pipe", "inherit"],
    encoding: "utf8",
  });

  if (result.status !== 0) return null;
  if (!result.stdout?.trim()) return null;

  const selectedNames = result.stdout
    .trim()
    .split("\n")
    .map((line) => line.split("\t")[0]!)
    .filter(Boolean);

  if (selectedNames.length === 0) return null;

  // Step 2: for each selected text/select arg, prompt for value
  const { textInput } = await import("./rt-render.tsx");
  const values = new Map<string, string | true>();

  for (const name of selectedNames) {
    const arg = argDefs.find((a) => a.name === name);
    if (!arg) continue;

    if (arg.type === "boolean") {
      values.set(name, true);
      continue;
    }

    if (arg.type === "select" && arg.options?.length) {
      const { filterableSelect } = await import("./rt-render.tsx");
      const val = await filterableSelect({
        message: arg.name,
        options: arg.options,
      });
      if (!val) return null;
      values.set(name, val);
      continue;
    }

    // text
    process.stderr.write("\x1b[2J\x1b[H");
    const val = await textInput({
      message: arg.name,
      placeholder: arg.placeholder,
      defaultValue: typeof arg.default === "string" ? arg.default : undefined,
      stderr: true,
    });
    if (val) values.set(name, val);
  }

  // Step 3: assemble CLI args in declaration order
  const assembled: string[] = [];
  for (const arg of argDefs) {
    const val = values.get(arg.name);
    if (val == null) continue;
    if (arg.type === "boolean") {
      if (arg.flag) assembled.push(arg.flag);
    } else if (typeof val === "string") {
      if (arg.flag) assembled.push(arg.flag, val);
      else assembled.push(val);
    }
  }

  return assembled;
}
