/**
 * Tests for `moa-router.ts` — the Dynamic Persona Generation (DPG)
 * Router that drives MoA's persona selection. The Router calls
 * `generateObject` on the utility model with a Zod schema; this test
 * suite mocks the AI SDK so every branch is exercised without spending
 * tokens.
 *
 * What we pin (the contracts a future refactor MUST NOT break):
 *
 *   - Happy path passes the LLM's persona list through verbatim,
 *     including the optional modelTier hint (PM #48), and bubbles up
 *     the usage record (PM #36 — soft budget visibility).
 *   - PM #37 — when the Router emits a persona set with NO reviewer
 *     (skeptic / critic / QA), the canonical Adversarial Critic is
 *     force-injected. CLAUDE.md §1's "always a skeptic" guarantee is
 *     contractual, not best-effort.
 *   - PM #37 cap — never exceed 5 personas; if the LLM hit the upper
 *     bound and we still need to inject, the LAST returned persona is
 *     evicted to make room.
 *   - PM #45 — reviewer detection in the Router uses
 *     `detectProposerRole`, the same helper PM #42 routes by. A persona
 *     called "qa_engineer" / "code_reviewer" counts as the skeptic so
 *     we don't force-inject a second one.
 *   - Bypass — `requiresSwarm: false` short-circuits the skeptic check.
 *   - LLM failure — the helper returns the static fallback
 *     `MOA_PROPOSERS` and marks `requiresSwarm: true` (better to spin
 *     up a swarm than silently drop to a single model).
 *   - fewShotsBlock (PM #51) — appended to the Router prompt verbatim
 *     and otherwise inert; passing an empty string is a no-op.
 *   - `abortSignal` is forwarded to the inner `generateObject` call
 *     (CLAUDE.md AbortSignal Propagation Contract — PM #23).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateObject: vi.fn(),
  };
});

vi.mock("@/lib/providers/llm-provider", () => ({
  createModel: vi.fn(() => ({ __opaque: "model-handle" })),
}));

import { generateObject } from "ai";
import { generateDynamicSwarm } from "./moa-router";
import { MOA_PROPOSERS } from "./moa-personas";
import type { ModelConfig } from "@/lib/types";
import type { ModelMessage } from "ai";

const mockedGenerateObject = vi.mocked(generateObject);

const STUB_MODEL: ModelConfig = {
  provider: "openrouter",
  model: "anthropic/claude-3-5-haiku",
  apiKey: "sk-stub",
};

const STUB_HISTORY: ModelMessage[] = [
  { role: "user", content: "previous question" },
  { role: "assistant", content: "previous answer" },
];

function fakeObjectResult(over: Partial<{
  requiresSwarm: boolean;
  personas: Array<{
    id: string;
    role: string;
    systemPrompt: string;
    color: string;
    modelTier?: "fast" | "balanced" | "frontier";
  }>;
}> = {}) {
  return {
    object: {
      requiresSwarm: over.requiresSwarm ?? true,
      personas: over.personas ?? [
        {
          id: "analyst",
          role: "Senior Analyst",
          systemPrompt: "analyze",
          color: "violet",
        },
        {
          id: "coder",
          role: "Senior Engineer",
          systemPrompt: "implement",
          color: "blue",
        },
        {
          id: "skeptic",
          role: "QA Auditor",
          systemPrompt: "find flaws",
          color: "rose",
        },
      ],
    },
    usage: { inputTokens: 100, outputTokens: 50 },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateDynamicSwarm — happy path", () => {
  it("returns the LLM's personas verbatim when a reviewer is present", async () => {
    mockedGenerateObject.mockResolvedValue(fakeObjectResult());
    const result = await generateDynamicSwarm(
      "Design a fault-tolerant queue",
      STUB_HISTORY,
      STUB_MODEL,
      false
    );
    expect(result.requiresSwarm).toBe(true);
    expect(result.personas.map((p) => p.id)).toEqual([
      "analyst",
      "coder",
      "skeptic",
    ]);
  });

  it("bubbles up the Router's usage so the chat banner can sum it (PM #36)", async () => {
    mockedGenerateObject.mockResolvedValue(fakeObjectResult());
    const result = await generateDynamicSwarm("x", [], STUB_MODEL, false);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("propagates the LLM's modelTier hint (PM #48) without mutation", async () => {
    mockedGenerateObject.mockResolvedValue(
      fakeObjectResult({
        personas: [
          {
            id: "skeptic",
            role: "QA",
            systemPrompt: "...",
            color: "rose",
            modelTier: "fast",
          },
          {
            id: "coder",
            role: "Senior Engineer",
            systemPrompt: "...",
            color: "blue",
            modelTier: "frontier",
          },
          {
            id: "researcher",
            role: "Domain Expert",
            systemPrompt: "...",
            color: "violet",
            modelTier: "balanced",
          },
        ],
      })
    );
    const result = await generateDynamicSwarm("x", [], STUB_MODEL, false);
    expect(result.personas[0].modelTier).toBe("fast");
    expect(result.personas[1].modelTier).toBe("frontier");
    expect(result.personas[2].modelTier).toBe("balanced");
  });

  it("requiresSwarm: false short-circuits the skeptic force-inject (bypass path)", async () => {
    mockedGenerateObject.mockResolvedValue(
      fakeObjectResult({
        requiresSwarm: false,
        personas: [
          // No reviewer here — but bypass means we don't run the swarm at all.
          {
            id: "x",
            role: "Generic",
            systemPrompt: "...",
            color: "blue",
          },
          {
            id: "y",
            role: "Generic2",
            systemPrompt: "...",
            color: "violet",
          },
          {
            id: "z",
            role: "Generic3",
            systemPrompt: "...",
            color: "emerald",
          },
        ],
      })
    );
    const result = await generateDynamicSwarm("hi", [], STUB_MODEL, false);
    expect(result.requiresSwarm).toBe(false);
    // Personas are returned as-is; the canonical critic is NOT injected
    // because the swarm isn't even going to run.
    expect(result.personas.find((p) => p.id === "critic")).toBeUndefined();
  });
});

describe("generateDynamicSwarm — PM #37 skeptic guarantee", () => {
  it("force-injects the canonical critic when the LLM omits a reviewer", async () => {
    mockedGenerateObject.mockResolvedValue(
      fakeObjectResult({
        personas: [
          { id: "analyst", role: "Analyst", systemPrompt: "...", color: "violet" },
          { id: "creative", role: "Brainstormer", systemPrompt: "...", color: "amber" },
          { id: "executor", role: "Tool Operator", systemPrompt: "...", color: "emerald" },
        ],
      })
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await generateDynamicSwarm("x", [], STUB_MODEL, false);
    const canonical = MOA_PROPOSERS.find((p) => p.id === "critic");
    expect(result.personas.some((p) => p.id === "critic")).toBe(true);
    const injected = result.personas.find((p) => p.id === "critic");
    expect(injected?.role).toBe(canonical?.role);
    expect(injected?.systemPrompt).toBe(canonical?.systemPrompt);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Skeptic.*force-injecting/i)
    );
    warnSpy.mockRestore();
  });

  it("does NOT inject when a reviewer is already present (PM #45 detection)", async () => {
    // PM #45: a persona called "qa_engineer" with "Quality Assurance" in
    // the role MUST be recognised as the skeptic — no second critic.
    mockedGenerateObject.mockResolvedValue(
      fakeObjectResult({
        personas: [
          {
            id: "qa_engineer",
            role: "Quality Assurance Engineer",
            systemPrompt: "...",
            color: "rose",
          },
          { id: "analyst", role: "Analyst", systemPrompt: "...", color: "violet" },
          { id: "coder", role: "Implementer", systemPrompt: "...", color: "blue" },
        ],
      })
    );
    const result = await generateDynamicSwarm("x", [], STUB_MODEL, false);
    // Only one persona with reviewer signal; no duplicate canonical critic.
    expect(result.personas.length).toBe(3);
    expect(result.personas.find((p) => p.id === "critic")).toBeUndefined();
    expect(result.personas[0].id).toBe("qa_engineer");
  });

  it("caps at 5 personas — evicts the LAST when the LLM returned a full 5 without a reviewer", async () => {
    mockedGenerateObject.mockResolvedValue(
      fakeObjectResult({
        personas: [
          { id: "p1", role: "Analyst", systemPrompt: "...", color: "violet" },
          { id: "p2", role: "Creative", systemPrompt: "...", color: "amber" },
          { id: "p3", role: "Pragmatist", systemPrompt: "...", color: "emerald" },
          { id: "p4", role: "Domain Expert", systemPrompt: "...", color: "blue" },
          { id: "p5", role: "Tool Operator", systemPrompt: "...", color: "cyan" }, // weakest tail pick
        ],
      })
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await generateDynamicSwarm("x", [], STUB_MODEL, false);
    expect(result.personas.length).toBe(5);
    expect(result.personas.map((p) => p.id)).toContain("critic");
    expect(result.personas.find((p) => p.id === "p5")).toBeUndefined(); // tail evicted
    expect(result.personas.find((p) => p.id === "p1")).toBeDefined(); // head preserved
  });
});

describe("generateDynamicSwarm — failure path", () => {
  it("falls back to static MOA_PROPOSERS when generateObject throws", async () => {
    mockedGenerateObject.mockRejectedValue(new Error("LLM blew up"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await generateDynamicSwarm("x", [], STUB_MODEL, false);
    expect(result.personas).toBe(MOA_PROPOSERS);
    expect(result.requiresSwarm).toBe(true); // err on the side of running the swarm
    expect(result.usage).toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Dynamic Persona Generation failed.*Falling back/i),
      expect.any(Error)
    );
    errSpy.mockRestore();
  });

  it("falls back when the LLM returns a malformed schema (generateObject throws ZodError)", async () => {
    mockedGenerateObject.mockRejectedValue(new Error("Zod parse failed"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await generateDynamicSwarm("x", [], STUB_MODEL, false);
    expect(result.personas).toBe(MOA_PROPOSERS);
  });
});

describe("generateDynamicSwarm — prompt shape", () => {
  it("includes the user message (truncated at 2000 chars) in the prompt", async () => {
    mockedGenerateObject.mockResolvedValue(fakeObjectResult());
    const longMessage = "x".repeat(5000);
    await generateDynamicSwarm(longMessage, [], STUB_MODEL, false);
    expect(mockedGenerateObject).toHaveBeenCalledOnce();
    const callArgs = mockedGenerateObject.mock.calls[0][0] as any;
    expect(callArgs.prompt).toContain("x".repeat(2000));
    expect(callArgs.prompt).not.toContain("x".repeat(2001));
  });

  it("formats up to 5 recent history messages as [ROLE]: content", async () => {
    mockedGenerateObject.mockResolvedValue(fakeObjectResult());
    const history: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ];
    await generateDynamicSwarm("now", history, STUB_MODEL, false);
    const prompt = (mockedGenerateObject.mock.calls[0][0] as any).prompt;
    expect(prompt).toMatch(/\[USER\]: first/);
    expect(prompt).toMatch(/\[ASSISTANT\]: second/);
    expect(prompt).toMatch(/\[USER\]: third/);
  });

  it("adds an EXTRA search_web mandate (instruction #7) when searchEnabled=true", async () => {
    // `search_web` is mentioned unconditionally inside the skeptic mandate
    // ("verify library compatibilities via search_web (if available)"), so
    // it always appears at least once. The contract under search_enabled
    // is that an EXTRA instruction (#7) with a dedicated paragraph
    // ("You have access to the 'search_web' tool") is appended.
    mockedGenerateObject.mockResolvedValue(fakeObjectResult());

    await generateDynamicSwarm("x", [], STUB_MODEL, true);
    const promptWithSearch = (mockedGenerateObject.mock.calls[0][0] as any)
      .prompt;
    expect(promptWithSearch).toMatch(/You have access to the 'search_web' tool/);

    mockedGenerateObject.mockClear();
    await generateDynamicSwarm("x", [], STUB_MODEL, false);
    const promptNoSearch = (mockedGenerateObject.mock.calls[0][0] as any)
      .prompt;
    expect(promptNoSearch).not.toMatch(
      /You have access to the 'search_web' tool/
    );
  });

  it("appends fewShotsBlock verbatim when provided (PM #51)", async () => {
    mockedGenerateObject.mockResolvedValue(fakeObjectResult());
    const fewshots =
      "\n\nPAST SUCCESSFUL PATTERNS:\n- alice-test-fingerprint-123";
    await generateDynamicSwarm("x", [], STUB_MODEL, false, undefined, fewshots);
    const prompt = (mockedGenerateObject.mock.calls[0][0] as any).prompt;
    expect(prompt).toContain("alice-test-fingerprint-123");
  });

  it("forwards abortSignal into generateObject (PM #23 contract)", async () => {
    mockedGenerateObject.mockResolvedValue(fakeObjectResult());
    const controller = new AbortController();
    await generateDynamicSwarm("x", [], STUB_MODEL, false, controller.signal);
    expect((mockedGenerateObject.mock.calls[0][0] as any).abortSignal).toBe(
      controller.signal
    );
  });
});
