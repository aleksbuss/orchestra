/**
 * Tests for `memorySave`, `memoryLoad`, `memoryDelete` — thin shells over
 * the `lib/memory/memory` API.
 *
 * Same contract as `knowledge-query.ts`: the agent consumes the STRING
 * return value, so any underlying error MUST surface as a string with a
 * stable prefix the agent can recognize. Throwing would kill the
 * tool-call loop.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/memory/memory", () => ({
  insertMemory: vi.fn(),
  searchMemory: vi.fn(),
  deleteMemoryByQuery: vi.fn(),
}));

import {
  memorySave,
  memoryLoad,
  memoryDelete,
} from "./memory-tools";
import {
  deleteMemoryByQuery,
  insertMemory,
  searchMemory,
} from "@/lib/memory/memory";

const mockedInsert = vi.mocked(insertMemory);
const mockedSearch = vi.mocked(searchMemory);
const mockedDelete = vi.mocked(deleteMemoryByQuery);

const fakeSettings = (override: Partial<{ similarityThreshold: number }> = {}) =>
  ({
    memory: {
      similarityThreshold: override.similarityThreshold ?? 0.35,
      enabled: true,
      maxResults: 10,
      chunkSize: 400,
    },
  } as any);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("memorySave", () => {
  it("forwards args + returns success message containing the inserted id and area", async () => {
    mockedInsert.mockResolvedValue("mem-id-123");
    const out = await memorySave("text", "user-prefs", "main", fakeSettings());
    expect(mockedInsert).toHaveBeenCalledWith("text", "user-prefs", "main", expect.any(Object));
    expect(out).toMatch(/Memory saved successfully/);
    expect(out).toContain("mem-id-123");
    expect(out).toContain("user-prefs");
  });

  it("returns a 'Failed to save memory:' string on Error (no throw)", async () => {
    mockedInsert.mockRejectedValue(new Error("disk full"));
    const out = await memorySave("text", "area", "main", fakeSettings());
    expect(out).toBe("Failed to save memory: disk full");
  });

  it("returns a stringified non-Error throw without crashing", async () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    mockedInsert.mockRejectedValue("plain throw");
    const out = await memorySave("text", "area", "main", fakeSettings());
    expect(out).toBe("Failed to save memory: plain throw");
  });
});

describe("memoryLoad", () => {
  it("uses settings.memory.similarityThreshold from the passed settings", async () => {
    mockedSearch.mockResolvedValue([]);
    await memoryLoad("query", 5, "main", fakeSettings({ similarityThreshold: 0.7 }));
    expect(mockedSearch).toHaveBeenCalledWith(
      "query",
      5,
      0.7, // threshold
      "main",
      expect.any(Object)
    );
  });

  it("returns 'No relevant memories found.' when result list is empty", async () => {
    mockedSearch.mockResolvedValue([]);
    const out = await memoryLoad("q", 5, "main", fakeSettings());
    expect(out).toBe("No relevant memories found.");
  });

  it("formats results with score (3 decimals) + area + text, joined by blank lines", async () => {
    mockedSearch.mockResolvedValue([
      { score: 0.91234, text: "first hit", metadata: { area: "user-prefs" } } as any,
      { score: 0.821, text: "second hit", metadata: { area: undefined } } as any,
    ]);

    const out = await memoryLoad("q", 5, "main", fakeSettings());
    expect(out).toContain("Found 2 relevant memories");
    expect(out).toContain("[1]");
    expect(out).toContain("(score: 0.912"); // truncated to 3 decimals
    expect(out).toContain("user-prefs");
    expect(out).toContain("first hit");
    expect(out).toContain("[2]");
    expect(out).toContain("unknown"); // missing area falls back to 'unknown'
  });

  it("returns 'Failed to search memory:' on underlying error", async () => {
    mockedSearch.mockRejectedValue(new Error("embed failure"));
    const out = await memoryLoad("q", 5, "main", fakeSettings());
    expect(out).toBe("Failed to search memory: embed failure");
  });
});

describe("memoryDelete", () => {
  it("returns 'No matching memories found' when delete returns 0", async () => {
    mockedDelete.mockResolvedValue(0);
    const out = await memoryDelete("nope", "main", fakeSettings());
    expect(out).toBe("No matching memories found to delete.");
  });

  it("returns the deleted-count message for any positive result", async () => {
    mockedDelete.mockResolvedValue(7);
    const out = await memoryDelete("matchy", "main", fakeSettings());
    expect(out).toBe("Deleted 7 matching memory entries.");
  });

  it("returns 'Failed to delete memories:' on error", async () => {
    mockedDelete.mockRejectedValue(new Error("vector store unreachable"));
    const out = await memoryDelete("q", "main", fakeSettings());
    expect(out).toBe("Failed to delete memories: vector store unreachable");
  });
});
