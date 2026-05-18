/**
 * Tests for the pure parsing helpers in `cli-models.ts`.
 *
 * The CLI-spawning side of `getCliProviderModels` (child_process,
 * timeout, cache) is integration-only; we don't cover it here. What we
 * DO cover is the parser that decides which tokens out of CLI output
 * count as valid model ids — that logic is independent of any runtime
 * env and is the most likely site of silent regressions when a new
 * model family ships (e.g. `o5-…`, `gpt-5-…`).
 *
 * Pinned invariants:
 *   - Codex matcher accepts `gpt-*` and `o1`/`o3`/`o4` (and their
 *     variants), rejects unrelated tokens.
 *   - Gemini matcher accepts `gemini-*` only.
 *   - JSON parsers walk arbitrary nested shapes (the CLIs change format
 *     between versions; we extract `id`/`model`/`name` fields wherever
 *     they appear).
 *   - Output is deduplicated and case-stable.
 */
import { describe, it, expect } from "vitest";
import {
  matchesCodexModel,
  matchesGeminiModel,
  parseCodexModels,
  parseGeminiModels,
} from "./cli-models";

describe("matchesCodexModel — accepted shapes", () => {
  it.each([
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4-turbo",
    "gpt-3.5-turbo",
    "gpt-5",
    "o1",
    "o1-pro",
    "o3",
    "o4-mini",
    "GPT-4o", // case-insensitive
  ])("accepts %s", (token) => {
    expect(matchesCodexModel(token)).toBe(true);
  });
});

describe("matchesCodexModel — rejected shapes", () => {
  it.each([
    "",
    "gemini-1.5-pro", // wrong family
    "claude-3-5-sonnet",
    "model-with-leading-junk gpt-4o", // anchors required
    "gpt-", // must have a body
    "o2", // intentional gap (only o1, o3, o4)
    "o5", // future-proofing requires updating the matcher
    "  gpt-4o  ", // unsanitized whitespace
  ])("rejects %s", (token) => {
    expect(matchesCodexModel(token)).toBe(false);
  });
});

describe("matchesGeminiModel", () => {
  it("accepts gemini-* family", () => {
    expect(matchesGeminiModel("gemini-2.5-flash")).toBe(true);
    expect(matchesGeminiModel("gemini-1.5-pro")).toBe(true);
    expect(matchesGeminiModel("Gemini-Pro")).toBe(true); // case-insensitive
  });

  it("rejects non-gemini ids", () => {
    expect(matchesGeminiModel("gpt-4o")).toBe(false);
    expect(matchesGeminiModel("claude-3")).toBe(false);
    expect(matchesGeminiModel("gemini-")).toBe(false);
  });
});

describe("parseCodexModels — JSON branches", () => {
  it("parses a flat array of strings", () => {
    const raw = JSON.stringify(["gpt-4o", "gpt-4o-mini", "claude-3"]);
    expect(parseCodexModels(raw)).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("parses an array of {id} records (current Codex shape)", () => {
    const raw = JSON.stringify([
      { id: "gpt-4o" },
      { id: "gpt-4o-mini", display: "Mini" },
      { id: "claude-3" }, // foreign — must be filtered
    ]);
    expect(parseCodexModels(raw)).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("walks nested shapes — extracts model ids from {data: [{id}]} and friends", () => {
    const raw = JSON.stringify({
      data: [{ id: "gpt-4o" }, { id: "o3", capabilities: ["tools"] }],
    });
    expect(parseCodexModels(raw)).toEqual(["gpt-4o", "o3"]);
  });

  it("falls back to JSONL when top-level parse fails", () => {
    const raw = [
      JSON.stringify({ id: "gpt-4o" }),
      "not json — random log line",
      JSON.stringify({ id: "o4-mini" }),
    ].join("\n");
    expect(parseCodexModels(raw)).toEqual(["gpt-4o", "o4-mini"]);
  });

  it("dedupes and sorts (case-stable)", () => {
    const raw = JSON.stringify([
      { id: "gpt-4o" },
      { id: "gpt-4o" }, // dup
      { id: "gpt-4o-mini" },
    ]);
    expect(parseCodexModels(raw)).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });
});

describe("parseCodexModels — regex fallback", () => {
  it("extracts inline-mentioned model ids from text output", () => {
    const raw = `
Available models:
  gpt-4o          (default)
  gpt-4o-mini
  o3
Use \`codex set-model\` to choose.
`;
    expect(parseCodexModels(raw)).toEqual(["gpt-4o", "gpt-4o-mini", "o3"]);
  });

  it("returns [] for output that has no model-shaped tokens", () => {
    expect(parseCodexModels("nothing here")).toEqual([]);
  });
});

describe("parseGeminiModels", () => {
  it("parses a {models: [{name}]} shape (Gemini CLI default)", () => {
    const raw = JSON.stringify({
      models: [
        { name: "gemini-2.5-flash" },
        { name: "gemini-1.5-pro" },
      ],
    });
    expect(parseGeminiModels(raw)).toEqual([
      "gemini-1.5-pro",
      "gemini-2.5-flash",
    ]);
  });

  it("regex fallback extracts gemini-* tokens from text", () => {
    const raw = "Available: gemini-1.5-pro, gemini-2.5-flash, gpt-4o (other)";
    expect(parseGeminiModels(raw)).toEqual([
      "gemini-1.5-pro",
      "gemini-2.5-flash",
    ]);
  });

  it("rejects non-gemini ids in mixed output", () => {
    const raw = JSON.stringify([
      { id: "gpt-4o" }, // wrong family — must NOT appear in gemini list
      { id: "gemini-2.5-flash" },
    ]);
    expect(parseGeminiModels(raw)).toEqual(["gemini-2.5-flash"]);
  });
});
