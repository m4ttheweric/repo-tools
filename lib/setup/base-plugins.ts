/**
 * rt's own baseline plugin set. Lives apart from `steps/plugins.ts` so the
 * `tool.plugins` validator can watch exactly what `plugins.install` installs
 * without a validator importing a step (or a second copy of the list drifting
 * from the first).
 */
export const BASE_PLUGINS: string[] = ["mattstack@mattstack", "fast-browser@mattstack", "chat@mattstack"];
