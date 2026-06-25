/**
 * Branch naming template resolver — VSCode extension copy.
 *
 * Synchronous-only: supports ${identifier}, ${teamPrefix}, ${ticketNumber},
 * ${titleSlug}. ${llmSlug:N} falls back to a mechanical slug (LLM is CLI-only).
 *
 * Mirrors lib/branch-naming.ts but stripped of async LLM dependency.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

export interface BranchNamingConfig {
  template: string;
}

export function loadBranchNamingConfig(
  dataDir: string,
): BranchNamingConfig | null {
  try {
    const configPath = join(dataDir, "branch-naming.json");
    if (!existsSync(configPath)) return null;
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof raw?.template !== "string" || !raw.template.trim()) return null;
    return { template: raw.template.trim() };
  } catch {
    return null;
  }
}

function mechanicalSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const VAR_RE = /\$\{([a-zA-Z]+(?::\d+)?)\}/g;

export function resolveBranchName(
  ticket: { identifier: string; title: string },
  config: BranchNamingConfig | null,
): string {
  const template = config?.template ?? "${identifier}-${titleSlug}";

  let result = "";
  let lastIndex = 0;

  VAR_RE.lastIndex = 0;

  let match: ReturnType<typeof VAR_RE.exec>;
  while ((match = VAR_RE.exec(template)) !== null) {
    result += template.slice(lastIndex, match.index);

    const raw = match[1]!;
    let varName: string;
    let llmMaxChars: number | undefined;

    if (raw.startsWith("llmSlug")) {
      const colonIdx = raw.indexOf(":");
      if (colonIdx === -1) {
        throw new Error(`Invalid variable \${${raw}}. \${llmSlug} requires :N`);
      }
      const n = parseInt(raw.slice(colonIdx + 1), 10);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid variable \${${raw}}. N must be a positive integer`);
      }
      varName = "llmSlug";
      llmMaxChars = n;
    } else {
      varName = raw;
    }

    switch (varName) {
      case "identifier":
        result += ticket.identifier.toLowerCase();
        break;
      case "teamPrefix":
        result += ticket.identifier.split("-")[0]?.toLowerCase() ?? "";
        break;
      case "ticketNumber":
        result += ticket.identifier.split("-").slice(1).join("-") ?? "";
        break;
      case "titleSlug":
        result += mechanicalSlug(ticket.title);
        break;
      case "llmSlug":
        // LLM is CLI-only; use mechanical slug truncated to maxChars
        result += mechanicalSlug(ticket.title).slice(0, llmMaxChars!);
        break;
      default:
        throw new Error(`Unknown variable \${${raw}}`);
    }

    lastIndex = match.index + match[0].length;
  }

  result += template.slice(lastIndex);
  result = result.replace(/^\/+|\/+$/g, "").trim();

  if (!result) {
    return `${ticket.identifier.toLowerCase()}-${mechanicalSlug(ticket.title)}`;
  }

  return result;
}
