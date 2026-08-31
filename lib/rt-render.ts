/**
 * Re-export shim. The prompt facade lives in lib/ui/prompts.ts and the step
 * runner in lib/ui/steps.ts (rendered by the bundled rt-ui helper); the fzf
 * pickers live in lib/fzf-select.ts. Nothing here touches Ink any more.
 * New code imports from those modules directly.
 */
export type { SelectOption } from "./fzf-select.ts";
export { filterableSelect, filterableMultiselect } from "./fzf-select.ts";
export { BackNavigation } from "./back-navigation.ts";
export { select, multiselect, confirm, textInput } from "./ui/prompts.ts";
export { createStepRunner, withSpinner, type StepRunner } from "./ui/steps.ts";
