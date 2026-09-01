/**
 * Re-export shim. The prompt facade lives in lib/ui/prompts.ts, the step
 * runner in lib/ui/steps.ts, and the filterable pickers in
 * lib/pick-wrappers.ts (all rendered by the bundled rt-ui helper). Nothing
 * here touches Ink any more. New code imports from those modules directly.
 */
export type { SelectOption } from "./pick-wrappers.ts";
export { filterableSelect, filterableMultiselect } from "./pick-wrappers.ts";
export { BackNavigation } from "./back-navigation.ts";
export { select, multiselect, confirm, textInput } from "./ui/prompts.ts";
export { createStepRunner, withSpinner, type StepRunner } from "./ui/steps.ts";
