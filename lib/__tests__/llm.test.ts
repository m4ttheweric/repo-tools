import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

// We'll import from the module once it exists
// For now, define the expected shape inline to write the test first.

const origHome = process.env.HOME;
const TMP = "/tmp/llm-test-home";

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, ".mattstack", "rt"), { recursive: true });
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
    mkdirSync(join(TMP, ".mattstack", "rt"), { recursive: true });
    writeFileSync(
      join(TMP, ".mattstack", "rt", "llm.json"),
      JSON.stringify({ model: "qwen3:4b" }),
    );
    const { loadLlmConfig } = await import("../llm.ts");
    const config = loadLlmConfig();
    expect(config.model).toBe("qwen3:4b");
    expect(config.url).toBe("http://localhost:11434"); // default
    expect(config.timeoutMs).toBe(15000);              // default
  });

  test("reads full config", async () => {
    mkdirSync(join(TMP, ".mattstack", "rt"), { recursive: true });
    writeFileSync(
      join(TMP, ".mattstack", "rt", "llm.json"),
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
    mkdirSync(join(TMP, ".mattstack", "rt"), { recursive: true });
    writeFileSync(join(TMP, ".mattstack", "rt", "llm.json"), "not json");
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

  test("creates ~/.mattstack/rt directory if it does not exist", async () => {
    rmSync(join(TMP, ".mattstack", "rt"), { recursive: true, force: true });
    const { saveLlmConfig, loadLlmConfig } = await import("../llm.ts");
    saveLlmConfig({ model: "llama3:8b" });
    const config = loadLlmConfig();
    expect(config.model).toBe("llama3:8b");
  });
});

describe("llmPrompt", () => {
  test("calls Ollama /api/chat with correct payload", async () => {
    const { saveLlmConfig } = await import("../llm.ts");
    saveLlmConfig({
      url: "http://localhost:12345",
      model: "test-model",
      timeoutMs: 5000,
    });

    // Mock fetch
    const origFetch = globalThis.fetch;
    let capturedBody: string | null = null;
    globalThis.fetch = mock(async (url, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ message: { content: "hello from llm" } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    try {
      const { llmPrompt } = await import("../llm.ts");
      const result = await llmPrompt("you are helpful", "say hi", { maxTokens: 10 });
      expect(result).toBe("hello from llm");
      expect(capturedBody).not.toBeNull();
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.model).toBe("test-model");
      expect(parsed.messages[0].role).toBe("system");
      expect(parsed.messages[0].content).toBe("you are helpful");
      expect(parsed.messages[1].role).toBe("user");
      expect(parsed.messages[1].content).toBe("say hi");
      expect(parsed.stream).toBe(false);
      expect(parsed.options.num_predict).toBe(10);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("throws LlmUnavailableError on connection refused", async () => {
    const { saveLlmConfig } = await import("../llm.ts");
    saveLlmConfig({ url: "http://localhost:12346", model: "x", timeoutMs: 500 });

    // Re-import to pick up new config
    const { llmPrompt } = await import("../llm.ts");
    await expect(llmPrompt("s", "u")).rejects.toThrow("LLM unavailable");
  });

  test("throws LlmUnavailableError on timeout", async () => {
    const { saveLlmConfig } = await import("../llm.ts");
    saveLlmConfig({ url: "http://localhost:12346", model: "x", timeoutMs: 100 });

    const { llmPrompt } = await import("../llm.ts");
    await expect(llmPrompt("s", "u")).rejects.toThrow("LLM unavailable");
  });

  test("throws LlmEmptyResponseError when model returns empty", async () => {
    const { saveLlmConfig } = await import("../llm.ts");
    saveLlmConfig({ url: "http://localhost:12345", model: "x", timeoutMs: 5000 });

    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ message: { content: "" } }), { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      const { llmPrompt } = await import("../llm.ts");
      await expect(llmPrompt("s", "u")).rejects.toThrow("empty response");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("listOllamaModels", () => {
  test("returns model list from Ollama /api/tags", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url) => {
      if (String(url).includes("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [
              { name: "qwen3:4b", size: 2411728896 },
              { name: "codellama:7b", size: 3945367808 },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const { listOllamaModels } = await import("../llm.ts");
      const models = await listOllamaModels("http://localhost:11434");
      expect(models).toHaveLength(2);
      expect(models[0]!.name).toBe("qwen3:4b");
      expect(models[1]!.name).toBe("codellama:7b");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("throws LlmUnavailableError when Ollama is down", async () => {
    const { listOllamaModels } = await import("../llm.ts");
    await expect(
      listOllamaModels("http://localhost:12346"),
    ).rejects.toThrow("LLM unavailable");
  });
});
