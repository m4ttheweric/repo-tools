import type { CommandArg } from "./command-tree.ts";

export async function collectArgs(
  label: string,
  argDefs: CommandArg[],
): Promise<string[] | null> {
  if (!argDefs.length) return [];

  // label is the command context arg-collector already has (command-tree.ts
  // builds it as `[...breadcrumb, resolvedName].join(" ")`), so splitting on
  // " " recovers the same segments for the picker header.
  const breadcrumb = label.split(" ");

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
    breadcrumb,
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
        // Appends the arg being collected as the final crumb, distinguishing
        // this sub-stage from the multiselect stage's own breadcrumb.
        breadcrumb: [...breadcrumb, arg.name],
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
