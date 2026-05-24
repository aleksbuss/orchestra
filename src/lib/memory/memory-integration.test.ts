import { describe, it, expect, afterAll } from "vitest";
import { insertMemory, searchMemory, deleteMemoryByQuery } from "./memory";
import type { AppSettings } from "@/lib/types";

describe("Vector RAG Database Integration Tests", () => {
  // Test fixture rebuilt 2026-05 to match current AppSettings shape (the
  // earlier literal carried fields like `id`, `name`, `url`, `apiKey` at
  // the top level + `ui` block that no longer exist on the type). Using
  // a cast-through-unknown for the fields we don't care about, but the
  // important ones (chatModel/embeddingsModel/memory) are typed correctly.
  const MOCK_SETTINGS = {
    chatModel: { provider: "openai" as const, model: "gpt-4o", maxTokens: 4000, temperature: 0.7 },
    // "mock" preserves the pre-refactor test behavior: the test fixture
    // doesn't talk to a real embedding provider, it uses the mock path.
    // We cast the whole settings object as unknown→AppSettings below, so
    // the provider literal type mismatch is intentional and ignored.
    embeddingsModel: { provider: "mock", model: "mock-model", dimensions: 1536 },
    utilityModel: { provider: "openai" as const, model: "gpt-4o-mini", maxTokens: 4000, temperature: 0.7 },
    providerApiKeys: {},
    memory: {
      enabled: true,
      similarityThreshold: 0.5, // We use a low threshold for safe testing
      maxResults: 10,
      chunkSize: 400,
    },
    codeExecution: { enabled: false, timeout: 60, maxOutputLength: 1000 },
    search: { enabled: false, provider: "none" as const },
    general: { darkMode: false, language: "en" },
    auth: { enabled: false, username: "admin", passwordHash: "", mustChangeCredentials: false },
  } as unknown as AppSettings;

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
