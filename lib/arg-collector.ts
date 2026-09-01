import type { CommandArg } from "./command-tree.ts";

export async function collectArgs(
  label: string,
  argDefs: CommandArg[],
): Promise<string[] | null> {
  if (!argDefs.length) return [];

  // Step 1: multi-select which args to include
  const { filterableMultiselect } = await import("./pick-wrappers.ts");
  const options = argDefs.map((arg) => ({
    value: arg.name,
    label: arg.flag ?? arg.name,
    hint: arg.hint,
  }));

  const selectedNames = await filterableMultiselect({
    message: `${label} args`,
    options,
  });

  if (!selectedNames || selectedNames.length === 0) return null;

  // Step 2: for each selected text/select arg, prompt for value
  const { textInput } = await import("./rt-render.ts");
  const values = new Map<string, string | true>();

  for (const name of selectedNames) {
    const arg = argDefs.find((a) => a.name === name);
    if (!arg) continue;

    if (arg.type === "boolean") {
      values.set(name, true);
      continue;
    }

    if (arg.type === "select" && arg.options?.length) {
      const { filterableSelect } = await import("./pick-wrappers.ts");
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
