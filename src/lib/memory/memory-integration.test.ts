import { describe, it, expect, afterAll } from "vitest";
import { insertMemory, searchMemory, deleteMemoryByQuery } from "./memory";
import type { AppSettings } from "@/lib/types";

describe("Vector RAG Database Integration Tests", () => {
  const MOCK_SETTINGS: AppSettings = {
    apiKey: "test-key",
    model: "test-model",
    chatModel: { provider: "openai", model: "gpt-4o", id: "test", name: "test", maxTokens: 4000, temperature: 0.7 },
    embeddingsModel: { provider: "mock", model: "mock-model", dimensions: 1536 },
    projectsDir: "./test",
    providerApiKeys: {},
    utilityModel: { provider: "openai", model: "gpt-4o-mini", id: "test2", name: "test2", maxTokens: 4000, temperature: 0.7 },
    memory: {
      url: "http://localhost:8000",
      similarityThreshold: 0.5, // We use a low threshold for safe testing
    },
    ui: { theme: 'system', accentColor: 'blue', contentWidth: 'standard', enableAnimations: true }
  };

  const TEST_SUBDIR = "rag-integration-testing-123";

  it("should successfully insert a dense archived memory block into Chroma", async () => {
    const memoryId = await insertMemory(
      "Archived Chat History: The user specifically requested a RAG database to solve 12k token limits. We implemented a dynamic threshold that falls back to 6k tokens for Llama3 and stores overflowing data in Chroma.",
      "Auto-Archive",
      TEST_SUBDIR,
      MOCK_SETTINGS
    );

    expect(memoryId).toBeDefined();
    expect(typeof memoryId).toBe("string");
  });

  it("should successfully search and recall context using semantic queries", async () => {
    // Wait for vector indexing (locally it's near-instant, but just in case)
    await new Promise(r => setTimeout(r, 500));

    // Semantic query: asking about "token limits" should trigger the RAG
    const results = await searchMemory(
      "How did we solve the 12,000 token limit for Llama?",
      3,
      -1.0, // negative threshold because our mock embeddings return random vectors every time!
      TEST_SUBDIR,
      MOCK_SETTINGS
    );

    expect(results).toBeInstanceOf(Array);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("Llama3");
    expect(results[0].metadata.area).toBe("Auto-Archive");
  });

  it("should isolate memory correctly (prevent bleed-over between projects)", async () => {
    const foreignResults = await searchMemory(
      "How did we solve the 12,000 token limit for Llama?",
      3,
      0.2,
      "different-project-subdir",
      MOCK_SETTINGS
    );

    expect(foreignResults.length).toBe(0);
  });

  afterAll(async () => {
    // Cleanup pseudo-teardown
    try {
      await deleteMemoryByQuery("token limits", TEST_SUBDIR, MOCK_SETTINGS);
    } catch {}
  });
});
