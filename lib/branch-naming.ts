import { join } from "path";
import { existsSync, readFileSync } from "fs";
import type { LinearTicket } from "./linear.ts";
import { LlmUnavailableError, LlmEmptyResponseError } from "./llm.ts";
import { dim, reset } from "./tui.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BranchNamingConfig {
  template: string;
}

// ─── Config loader ───────────────────────────────────────────────────────────

/**
 * Load per-repo branch naming config from `dataDir/branch-naming.json`.
 * Returns null if the file doesn't exist, is invalid, or the template is empty.
 */
export function loadBranchNamingConfig(
  dataDir: string,
): BranchNamingConfig | null {
  const configPath = join(dataDir, "branch-naming.json");

  if (!existsSync(configPath)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }

  if (typeof raw !== "object" || raw === null) return null;

  const template = (raw as Record<string, unknown>).template;
  if (typeof template !== "string" || !template.trim()) return null;

  return { template: template.trim() };
}

// ─── Slug helpers ────────────────────────────────────────────────────────────

function mechanicalSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function slugifyTitle(title: string, maxLen = 50): string {
  const slug = mechanicalSlug(title);
  return slug.length <= maxLen ? slug : truncateAtDash(slug, maxLen);
}

function truncateAtDash(slug: string, maxChars: number): string {
  const lastDash = slug.lastIndexOf("-", maxChars);
  return lastDash > 0 ? slug.slice(0, lastDash) : slug.slice(0, maxChars);
}

// ─── Variable names (for error messages) ─────────────────────────────────────

const IDENTIFIER = "identifier";
const TEAM_PREFIX = "teamPrefix";
const TICKET_NUMBER = "ticketNumber";
const TITLE_SLUG = "titleSlug";
const LLM_SLUG = "llmSlug";

// ─── Template resolver ───────────────────────────────────────────────────────

const VAR_RE = /\$\{([a-zA-Z]+(?::[a-zA-Z0-9]+)?)\}/g;

/**
 * Resolve a branch name from a Linear ticket using a configurable template.
 *
 * Supported variables:
 *   ${identifier}   — full Linear identifier, lowercased (e.g. "cv-1287")
 *   ${teamPrefix}   — the team portion of the identifier (e.g. "cv")
 *   ${ticketNumber} — the numeric portion of the identifier (e.g. "1287")
 *   ${titleSlug}    — mechanical slug of the ticket title
 *   ${llmSlug:N}    — LLM-generated slug, max N chars; falls back to
 *                      truncated mechanical slug on LLM failure
 *
 * When `config` is null, falls back to `${identifier}-${titleSlug}`.
 */
export async function resolveBranchName(
  ticket: LinearTicket,
  config: BranchNamingConfig | null,
): Promise<string> {
  const template = config?.template ?? "${identifier}-${titleSlug}";

  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Reset regex state
  VAR_RE.lastIndex = 0;

  while ((match = VAR_RE.exec(template)) !== null) {
    // Append literal text before this variable
    result += template.slice(lastIndex, match.index);

    const raw = match[1]!;
    let varName: string;
    let llmMaxChars: number | undefined;

    if (raw.startsWith("llmSlug")) {
      const colonIdx = raw.indexOf(":");
      if (colonIdx === -1) {
        throw new Error(
          `Invalid variable \${${raw}}. \${${LLM_SLUG}} requires :N (e.g. \${${LLM_SLUG}}:10)`,
        );
      }
      const numStr = raw.slice(colonIdx + 1);
      const n = parseInt(numStr, 10);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(
          `Invalid variable \${${raw}}. \${${LLM_SLUG}}:N requires a positive integer N`,
        );
      }
      varName = LLM_SLUG;
      llmMaxChars = n;
    } else {
      varName = raw;
    }

    let value: string;

    switch (varName) {
      case "identifier":
        value = ticket.identifier.toLowerCase();
        break;
      case "teamPrefix": {
        const parts = ticket.identifier.split("-");
        value = parts[0]?.toLowerCase() ?? "";
        break;
      }
      case "ticketNumber": {
        const parts = ticket.identifier.split("-");
        value = parts.slice(1).join("-") ?? "";
        break;
      }
      case "titleSlug":
        value = slugifyTitle(ticket.title);
        break;
      case "llmSlug": {
        value = await resolveLlmSlug(ticket.title, llmMaxChars!);
        break;
      }
      default:
        throw new Error(
          `Unknown variable \${${raw}} in branch naming template. ` +
          `Supported: ${IDENTIFIER}, ${TEAM_PREFIX}, ${TICKET_NUMBER}, ${TITLE_SLUG}, ${LLM_SLUG}:N`,
        );
    }

    result += value;
    lastIndex = match.index + match[0].length;
  }

  // Append remaining literal text after the last variable
  result += template.slice(lastIndex);

  // Strip leading/trailing slashes and whitespace
  result = result.replace(/^\/+|\/+$/g, "").trim();

  if (!result) {
    // Ultimate fallback — should never reach here with valid config
    return `${ticket.identifier.toLowerCase()}-${slugifyTitle(ticket.title)}`;
  }

  return result;
}

async function resolveLlmSlug(title: string, maxChars: number): Promise<string> {
  try {
    const { llmSummarize } = await import("./llm.ts");
    return await llmSummarize(title, maxChars);
  } catch (err) {
    if (err instanceof LlmUnavailableError || err instanceof LlmEmptyResponseError) {
      // Fall back to mechanical slug, truncated to maxChars at a word boundary
      process.stderr.write(`  ${dim}llm unavailable (${err.message}), using mechanical slug${reset}\n`);
      const slug = mechanicalSlug(title);
      return slug.length <= maxChars ? slug : truncateAtDash(slug, maxChars);
    }
    throw err;
  }
}
