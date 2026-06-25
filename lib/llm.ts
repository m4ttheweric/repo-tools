import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { rtDir } from "./rt-paths.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LlmConfig {
  provider: "ollama";
  url: string;
  model: string;
  timeoutMs: number;
}

const DEFAULT_CONFIG: LlmConfig = {
  provider: "ollama",
  url: "http://localhost:11434",
  model: "",
  timeoutMs: 15_000,
};

export class LlmUnavailableError extends Error {
  constructor(reason: string) {
    super(`LLM unavailable: ${reason}`);
    this.name = "LlmUnavailableError";
  }
}

export class LlmEmptyResponseError extends Error {
  constructor() {
    super("LLM returned empty response");
    this.name = "LlmEmptyResponseError";
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────

export const LLM_CONFIG_PATH = join(rtDir(), "llm.json");

export function loadLlmConfig(): LlmConfig {
  try {
    if (existsSync(LLM_CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(LLM_CONFIG_PATH, "utf8"));
      return { ...DEFAULT_CONFIG, ...raw };
    }
  } catch { /* malformed JSON — use defaults */ }
  return { ...DEFAULT_CONFIG };
}

export function saveLlmConfig(partial: Partial<LlmConfig>): void {
  const dir = rtDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = loadLlmConfig();
  const merged = { ...current, ...partial };
  writeFileSync(LLM_CONFIG_PATH, JSON.stringify(merged, null, 2));
}

// ─── Ollama API ──────────────────────────────────────────────────────────────

interface OllamaTagsResponse {
  models: Array<{ name: string; size: number }>;
}

/**
 * Send a prompt to the configured local LLM via Ollama.
 *
 * Uses Ollama's /api/generate endpoint with raw mode (no chat template).
 * The prompt is formatted as a simple system + user message block.
 *
 * @throws {LlmUnavailableError} if Ollama is unreachable or times out
 * @throws {LlmEmptyResponseError} if the model returns an empty string
 */
export async function llmPrompt(
  system: string,
  user: string,
  opts?: { maxTokens?: number },
): Promise<string> {
  const config = loadLlmConfig();

  if (!config.model) throw new LlmUnavailableError("no model configured");

  let response: Response;
  try {
    response = await fetch(`${config.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
        options: opts?.maxTokens ? { num_predict: opts.maxTokens } : undefined,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LlmUnavailableError(msg);
  }

  if (!response.ok) {
    throw new LlmUnavailableError(`HTTP ${response.status}`);
  }

  const json = (await response.json()) as { message?: { content?: string } };
  const text = (json.message?.content ?? "").trim();

  if (!text) throw new LlmEmptyResponseError();

  return text;
}

/**
 * Generate a short, descriptive slug from `text` using the local LLM.
 *
 * The system prompt instructs the model to produce a compact hyphenated slug
 * (no articles, no verbs, just key nouns). `maxChars` controls the approximate
 * output length by setting `num_predict` to `maxChars + 4` (buffer for
 * punctuation / spacing that we then strip).
 *
 * On failure, throws — callers should catch and fall back to a mechanical slug.
 */
export async function llmSummarize(text: string, maxChars: number): Promise<string> {
  const prompt = `Turn this ticket title into a short hyphenated branch slug (${maxChars} chars max). Output only the slug:\n\n"${text}"`;

  // Don't set num_predict — thinking models (qwen3.6) use tokens for
  // internal reasoning and need unconstrained budget to produce content.
  const result = await llmPrompt(
    "Reply with only a short hyphenated slug. No explanation.",
    prompt,
  );

  // Post-process: lowercase, strip non-slug chars, collapse hyphens, trim to length
  const slug = result
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return truncateAtWordBoundary(slug, maxChars);
}

function truncateAtWordBoundary(slug: string, maxChars: number): string {
  if (slug.length <= maxChars) return slug;
  const lastDash = slug.lastIndexOf("-", maxChars);
  // If a dash exists within the limit, cut there; otherwise take the first word
  return lastDash > 0 ? slug.slice(0, lastDash) : slug.slice(0, maxChars);
}

/**
 * List locally installed Ollama models.
 *
 * @throws {LlmUnavailableError} if Ollama is unreachable
 */
export async function listOllamaModels(
  url: string,
): Promise<Array<{ name: string; size: string }>> {
  let response: Response;
  try {
    response = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LlmUnavailableError(msg);
  }

  if (!response.ok) throw new LlmUnavailableError(`HTTP ${response.status}`);

  const json = (await response.json()) as OllamaTagsResponse;
  return (json.models ?? []).map(m => ({
    name: m.name,
    size: formatBytes(m.size),
  }));
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  const mb = bytes / (1024 ** 2);
  return `${Math.round(mb)}MB`;
}
