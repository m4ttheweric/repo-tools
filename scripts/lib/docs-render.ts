import type { CommandArg } from "../../lib/command-tree.ts";

export type CommonFlags = { flags: Set<string>; href: string };

export function slugArg(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, "-");
}

export function renderUsage(path: string[], args?: CommandArg[]): string {
  const positionals = (args ?? [])
    .filter((a) => !a.flag)
    .map((a) => `<${slugArg(a.name)}>`);
  const hasFlags = (args ?? []).some((a) => a.flag);
  const line = ["rt", ...path, ...positionals, hasFlags ? "[flags]" : ""]
    .filter(Boolean)
    .join(" ");
  return ["## Usage", "", "```bash", line, "```", ""].join("\n");
}

export function renderArgsTable(
  args: CommandArg[] | undefined,
  common: CommonFlags,
): string {
  if (!args || args.length === 0) return "";
  const rows = args.map((a) => {
    const token = a.flag ?? `<${slugArg(a.name)}>`;
    const label = a.flag && common.flags.has(a.flag)
      ? `[\`${token}\`](${common.href})`
      : `\`${token}\``;
    const def = a.default === undefined ? "" : `\`${String(a.default)}\``;
    const hint = a.hint ?? "";
    return `| ${label} | ${a.type} | ${def} | ${hint} |`;
  });
  return [
    "## Arguments & flags",
    "",
    "| Flag / Arg | Type | Default | Description |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
