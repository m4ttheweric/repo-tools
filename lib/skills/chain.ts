import type { StageEntry } from "./types.ts";

/**
 * The same fold resolve-pipeline.sh performed at run time, moved to compile:
 * a stage may only consume what the seed or an earlier stage produced.
 */
export function validateChain(workType: string, stages: StageEntry[], seed: string[]): string[] {
  const errors: string[] = [];
  const available = new Set(seed);
  for (const stage of stages) {
    for (const field of stage.consumes) {
      if (!available.has(field)) {
        errors.push(
          `pipeline "${workType}": stage "${stage.name}" consumes "${field}" but no earlier stage produces it and it is not in the seed`,
        );
      }
    }
    for (const field of stage.produces) available.add(field);
  }
  return errors;
}
