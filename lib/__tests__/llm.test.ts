import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

// We'll import from the module once it exists
// For now, define the expected shape inline to write the test first.

const origHome = process.env.HOME;
const TMP = "/tmp/llm-test-home";

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, ".rt"), { recursive: true });
  process.env.HOME = TMP;
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(TMP, { recursive: true, force: true });
});

describe("loadLlmConfig", () => {
  test("returns defaults when no config file exists", async () => {
    const { loadLlmConfig } = await import("../llm.ts");
    const config = loadLlmConfig();
    expect(config.provider).toBe("ollama");
    expect(config.url).toBe("http://localhost:11434");
    expect(config.model).toBe("");
    expect(config.timeoutMs).toBe(15000);
  });

  test("reads existing config and fills in missing defaults", async () => {
    mkdirSync(join(TMP, ".rt"), { recursive: true });
    writeFileSync(
      join(TMP, ".rt", "llm.json"),
      JSON.stringify({ model: "qwen3:4b" }),
    );
    const { loadLlmConfig } = await import("../llm.ts");
    const config = loadLlmConfig();
    expect(config.model).toBe("qwen3:4b");
    expect(config.url).toBe("http://localhost:11434"); // default
    expect(config.timeoutMs).toBe(15000);              // default
  });

  test("reads full config", async () => {
    mkdirSync(join(TMP, ".rt"), { recursive: true });
    writeFileSync(
      join(TMP, ".rt", "llm.json"),
      JSON.stringify({
        provider: "ollama",
        url: "http://10.0.0.5:11434",
        model: "codellama:7b",
        timeoutMs: 30000,
      }),
    );
    const { loadLlmConfig } = await import("../llm.ts");
    const config = loadLlmConfig();
    expect(config.url).toBe("http://10.0.0.5:11434");
    expect(config.model).toBe("codellama:7b");
    expect(config.timeoutMs).toBe(30000);
  });

  test("handles malformed JSON gracefully", async () => {
    mkdirSync(join(TMP, ".rt"), { recursive: true });
    writeFileSync(join(TMP, ".rt", "llm.json"), "not json");
    const { loadLlmConfig } = await import("../llm.ts");
    const config = loadLlmConfig();
    expect(config.provider).toBe("ollama"); // falls back to defaults
  });
});

describe("saveLlmConfig", () => {
  test("writes config merging with existing values", async () => {
    const { loadLlmConfig, saveLlmConfig } = await import("../llm.ts");
    saveLlmConfig({ model: "qwen3:4b", timeoutMs: 20000 });
    const config = loadLlmConfig();
    expect(config.model).toBe("qwen3:4b");
    expect(config.timeoutMs).toBe(20000);
    expect(config.url).toBe("http://localhost:11434"); // preserved from defaults
  });

  test("creates ~/.rt directory if it does not exist", async () => {
    rmSync(join(TMP, ".rt"), { recursive: true, force: true });
    const { saveLlmConfig, loadLlmConfig } = await import("../llm.ts");
    saveLlmConfig({ model: "llama3:8b" });
    const config = loadLlmConfig();
    expect(config.model).toBe("llama3:8b");
  });
});
