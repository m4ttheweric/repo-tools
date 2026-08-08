/**
 * evidence.jsonc: the per-repo overlay that tells the evidence runner how
 * to drive the pod-side app: what the views look like, which recipes
 * capture them, and how to log in. Loose-parsed the same way
 * loadGateManifest reads gates.jsonc (lib/validate-farm.ts): JSONC bytes →
 * stripJsonc → JSON.parse, with schema enforcement left to field-presence
 * checks rather than a validation library. Unlike loadGateManifest, a
 * missing or malformed overlay here is expected (not every repo ships
 * evidence config yet), so this loader returns null instead of throwing.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { stripJsonc } from "./jsonc.ts";
import { reposDir } from "./rt-paths.ts";

export interface EvidenceView {
  path: string;
  ready?: { selector: string };
  identityGated?: boolean;
}

export interface EvidenceAnnotationPlan {
  target: string;
  kind: "arrow" | "blur" | "highlight" | "label";
  label?: string;
}

export interface EvidenceRecipe {
  flow?: string;
  args?: Record<string, string>;
  annotate?: EvidenceAnnotationPlan[];
}

export interface EvidenceLogin {
  url: string;
  fields: Record<string, string>;
  submit: string;
  assertAuthed: { selector: string };
}

export interface EvidenceConfig {
  /** Required; rt never hardcodes a default evidence tree. */
  evidenceRoot: string;
  /** Pod-side app port the runner navigates against. */
  appPort: number;
  views: Record<string, EvidenceView>;
  recipes: Record<string, EvidenceRecipe>;
  login: EvidenceLogin;
}

/** Loads ~/.rt/repos/<repoId>/evidence.jsonc; null when missing or malformed, never throws. */
export function loadEvidenceConfig(repoId: string, reposRoot?: string): EvidenceConfig | null {
  let raw: unknown;
  try {
    const text = readFileSync(join(reposRoot ?? reposDir(), repoId, "evidence.jsonc"), "utf8");
    raw = JSON.parse(stripJsonc(text));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const cfg = raw as Record<string, unknown>;
  if (typeof cfg.evidenceRoot !== "string") return null;
  if (typeof cfg.appPort !== "number") return null;
  if (cfg.views === null || typeof cfg.views !== "object") return null;
  if (cfg.recipes === null || typeof cfg.recipes !== "object") return null;
  if (cfg.login === null || typeof cfg.login !== "object") return null;
  return cfg as unknown as EvidenceConfig;
}

/** Expands a leading ~ or $VAR in evidenceRoot, resolved at call time (call-time HOME). */
export function expandEvidenceRoot(root: string): string {
  const home = process.env.HOME ?? homedir();
  let expanded = root;
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = home + expanded.slice(1);
  }
  expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) => {
    return process.env[name] ?? match;
  });
  return expanded;
}

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\??\}/g;

/** {name} and {name?} tokens declared in a view's path, in appearance order. */
export function viewPlaceholders(view: EvidenceView): string[] {
  const names: string[] = [];
  for (const match of view.path.matchAll(PLACEHOLDER_RE)) {
    names.push(match[1]!);
  }
  return names;
}

/** True when the token for `name` in the path is optional ({name?}). */
function isOptionalPlaceholder(view: EvidenceView, name: string): boolean {
  const re = new RegExp(`\\{${name}\\?\\}`);
  return re.test(view.path);
}

/**
 * Enforces "declared placeholders only": the view and recipe must exist,
 * every arg key must be covered by the view's placeholders or the recipe's
 * declared args, and every required (non-`?`) placeholder must be present.
 * Returns a human error string, or null when the request is valid.
 */
export function validateRequestArgs(
  config: EvidenceConfig,
  view: string,
  recipe: string,
  args: Record<string, string>,
): string | null {
  const viewConfig = config.views[view];
  if (!viewConfig) return `unknown view "${view}"`;
  const recipeConfig = config.recipes[recipe];
  if (!recipeConfig) return `unknown recipe "${recipe}"`;

  const placeholders = viewPlaceholders(viewConfig);
  const declaredRecipeArgs = Object.keys(recipeConfig.args ?? {});
  const allowed = new Set([...placeholders, ...declaredRecipeArgs]);

  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      return `undeclared arg "${key}" (not a placeholder in view "${view}" or a declared arg on recipe "${recipe}")`;
    }
  }

  // caseId is supplied by the runner itself (the case under capture), never
  // by the request's args, so it is exempt from the required-placeholder
  // check even though its token has no trailing `?`.
  for (const name of placeholders) {
    if (name === "caseId") continue;
    if (isOptionalPlaceholder(viewConfig, name)) continue;
    if (args[name] === undefined) {
      return `missing required placeholder "${name}" for view "${view}"`;
    }
  }

  return null;
}
