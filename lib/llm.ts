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
