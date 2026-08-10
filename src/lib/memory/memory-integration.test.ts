import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";
import type { AppSettings } from "@/lib/types";

// The store is imported LAZILY, after `ORCHESTRA_DATA_DIR` is redirected.
// `memory.ts` captures `getDataDir()` in a module-level const at import time,
// and ESM hoists static imports above every hook — so a static import here
// would bind the OPERATOR'S LIVE data dir before any `beforeAll` could run.
// It did: this file wrote real vectors into `data/memory/` on every run.
// Measured by diffing `data/` around a suite run, not by reading the code.
const store = () => import("./memory");

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

  let tmpDir: string;
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "orchestra-memory-"));
    previousDataDir = process.env.ORCHESTRA_DATA_DIR;
    process.env.ORCHESTRA_DATA_DIR = tmpDir;
  });

  it("runs against an isolated data dir, not the operator's live one", async () => {
    const { getDataDir } = await import("@/lib/storage/data-dir");
    expect(getDataDir()).toBe(path.resolve(tmpDir));
  });

  const TEST_SUBDIR = "rag-integration-testing-123";

  it("should successfully insert a dense archived memory block into Chroma", async () => {
    const memoryId = await (await store()).insertMemory(
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
    const results = await (await store()).searchMemory(
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
    const foreignResults = await (await store()).searchMemory(
      "How did we solve the 12,000 token limit for Llama?",
      3,
      0.2,
      "different-project-subdir",
      MOCK_SETTINGS
    );

    expect(foreignResults.length).toBe(0);
  });

  afterAll(async () => {
    // Restore first: later files in this worker must not inherit the redirect.
    if (previousDataDir === undefined) delete process.env.ORCHESTRA_DATA_DIR;
    else process.env.ORCHESTRA_DATA_DIR = previousDataDir;
    // Cleanup pseudo-teardown
    try {
      await (await store()).deleteMemoryByQuery("token limits", TEST_SUBDIR, MOCK_SETTINGS);
    } catch {}
  });
});
