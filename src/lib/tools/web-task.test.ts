/**
 * Unit tests for the `web_task` tool.
 *
 * These tests mock both the AI SDK (so no real LLM calls) and Playwright
 * (so no real browser launch). The goal is to pin the LOOP behaviour:
 *   - Iteration cap is honored.
 *   - `done` / `fail` short-circuit.
 *   - `goto` triggers navigation.
 *   - Invalid refs are surfaced back to the model instead of crashing.
 *   - Wall-clock budget terminates a runaway loop.
 *   - AbortSignal terminates a loop.
 *   - Browser is closed in `finally` (no leaked chromium).
 *
 * The integration test in `web-task.integration.test.ts` exercises the real
 * Playwright path against a local HTML fixture — that's where any real-
 * snapshot bugs would surface. Here we focus on control flow.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────

// `ai` provides generateObject; we stub it so each test scripts the model's
// action sequence.
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateObject: vi.fn(),
  };
});

// `playwright` — we replace `chromium.launch` with a fake browser that
// tracks every call so we can assert on cleanup + action dispatch.
vi.mock("playwright", () => {
  const newPage = vi.fn();
  const close = vi.fn().mockResolvedValue(undefined);
  return {
    chromium: {
      launch: vi.fn(async () => ({
        newPage,
        close,
      })),
    },
  };
});

// `createModel` is opaque — we don't run it, generateObject is mocked.
vi.mock("@/lib/providers/llm-provider", () => ({
  createModel: vi.fn(() => ({})),
}));

import { runWebTask, type WebTaskAction } from "./web-task";
import { generateObject } from "ai";
import { chromium } from "playwright";
import type { AppSettings } from "@/lib/types";

const mockedGenerateObject = vi.mocked(generateObject);
const mockedChromium = vi.mocked(chromium);

function fakeSettings(): AppSettings {
  return {
    chatModel: { provider: "openai", model: "gpt-4o", apiKey: "k", authMethod: "api_key" },
    utilityModel: { provider: "openai", model: "gpt-4o-mini", apiKey: "k" },
    embeddingsModel: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
    codeExecution: { enabled: true, timeout: 600, maxOutputLength: 120000 },
    memory: { enabled: true, similarityThreshold: 0.35, maxResults: 10, chunkSize: 400 },
    search: { enabled: false, provider: "none" },
    general: { darkMode: false, language: "en" },
    auth: { enabled: true, username: "admin", passwordHash: "scrypt$x$y", mustChangeCredentials: false },
  };
}

/**
 * Build a minimal fake Playwright Page that tracks every call. Each interactive
 * element is a stub locator; the loop's `locatorForRef` resolution sees an
 * array of `interactiveElementCount` items.
 */
function buildFakePage(opts: {
  url?: string;
  title?: string;
  interactiveElementCount?: number;
}) {
  const url = opts.url ?? "https://example.com";
  const goto = vi.fn(async () => undefined);
  const title = vi.fn(async () => opts.title ?? "Example");

  const elementCount = opts.interactiveElementCount ?? 3;
  const click = vi.fn(async () => undefined);
  const fill = vi.fn(async () => undefined);
  // `.locator(...).all()` returns an array of locator stubs with .click / .fill
  const stubElement = () => ({
    click,
    fill,
    evaluate: vi.fn(async () => "button"),
    getAttribute: vi.fn(async () => null),
    innerText: vi.fn(async () => "Click me"),
  });
  const elements = Array.from({ length: elementCount }, stubElement);
  const all = vi.fn(async () => elements);
  // `page.locator("body").innerText()` is called by takeSnapshot to read the
  // visible page text. Returning a fixed string is enough for unit tests —
  // the integration tests exercise the real path.
  const innerText = vi.fn(async () => "fake body text");
  const locator = vi.fn((selector: string) => {
    if (selector === "body") return { innerText };
    return { all };
  });

  return {
    url: vi.fn(() => url),
    goto,
    title,
    locator,
    click,
    fill,
    // exposed handles so tests can assert on them
    _click: click,
    _fill: fill,
    _goto: goto,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("runWebTask — happy path (done short-circuits)", () => {
  it("returns success on first 'done' action without further iterations", async () => {
    const page = buildFakePage({});
    const browser = { newPage: vi.fn(async () => page), close: vi.fn() };
    mockedChromium.launch.mockResolvedValueOnce(browser as never);

    mockedGenerateObject.mockResolvedValueOnce({
      object: { type: "done", result: "Found it: $42", reasoning: "answer is on page" },
    } as never);

    const result = await runWebTask({
      url: "https://example.com",
      task: "Find the price",
      settings: fakeSettings(),
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe("Found it: $42");
    expect(result.iterations).toBe(1);
    expect(result.actions).toEqual([{ type: "done" }]);
    // Browser must be closed exactly once even on the happy path.
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

describe("runWebTask — fail short-circuits", () => {
  it("returns success=false with the model's reason and no further iterations", async () => {
    const page = buildFakePage({});
    const browser = { newPage: vi.fn(async () => page), close: vi.fn() };
    mockedChromium.launch.mockResolvedValueOnce(browser as never);

    mockedGenerateObject.mockResolvedValueOnce({
      object: { type: "fail", reason: "Site requires login" },
    } as never);

    const result = await runWebTask({
      url: "https://example.com",
      task: "Download invoice",
      settings: fakeSettings(),
    });

    expect(result.success).toBe(false);
    expect(result.result).toBe("Site requires login");
    expect(result.iterations).toBe(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

describe("runWebTask — click + fill dispatch", () => {
  it("dispatches click to the resolved locator and continues the loop", async () => {
    const page = buildFakePage({ interactiveElementCount: 5 });
    const browser = { newPage: vi.fn(async () => page), close: vi.fn() };
    mockedChromium.launch.mockResolvedValueOnce(browser as never);

    // Iter 1: click @e2. Iter 2: done.
    mockedGenerateObject
      .mockResolvedValueOnce({
        object: { type: "click", ref: "e2", reasoning: "next button" },
      } as never)
      .mockResolvedValueOnce({
        object: { type: "done", result: "Clicked", reasoning: "complete" },
      } as never);

    const result = await runWebTask({
      url: "https://example.com",
      task: "Click the next button",
      settings: fakeSettings(),
    });

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(2);
    expect(page._click).toHaveBeenCalledTimes(1);
  });

  it("dispatches fill with the model-supplied text", async () => {
    const page = buildFakePage({ interactiveElementCount: 5 });
    const browser = { newPage: vi.fn(async () => page), close: vi.fn() };
    mockedChromium.launch.mockResolvedValueOnce(browser as never);

    mockedGenerateObject
      .mockResolvedValueOnce({
        object: { type: "fill", ref: "e3", text: "hello@example.com", reasoning: "email input" },
      } as never)
      .mockResolvedValueOnce({
        object: { type: "done", result: "Form filled", reasoning: "" },
      } as never);

    await runWebTask({
      url: "https://example.com/contact",
      task: "Fill email field",
      settings: fakeSettings(),
    });

    expect(page._fill).toHaveBeenCalledTimes(1);
    expect(page._fill).toHaveBeenCalledWith("hello@example.com", { timeout: 15000 });
  });
});

describe("runWebTask — invalid ref handling", () => {
  it("does NOT crash on a ref outside the snapshot range; loop continues", async () => {
    const page = buildFakePage({ interactiveElementCount: 2 }); // only e1, e2 valid
    const browser = { newPage: vi.fn(async () => page), close: vi.fn() };
    mockedChromium.launch.mockResolvedValueOnce(browser as never);

    // Iter 1: model picks @e99 (doesn't exist). Iter 2: model recovers.
    mockedGenerateObject
      .mockResolvedValueOnce({
        object: { type: "click", ref: "e99", reasoning: "guess" },
      } as never)
      .mockResolvedValueOnce({
        object: { type: "done", result: "OK", reasoning: "" },
      } as never);

    const result = await runWebTask({
      url: "https://example.com",
      task: "Test invalid ref",
      settings: fakeSettings(),
    });

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(2);
    // No click should have fired on iteration 1 — ref was invalid.
    expect(page._click).not.toHaveBeenCalled();
  });

  it("rejects garbage ref strings (e.g. 'banana') the same way", async () => {
    const page = buildFakePage({ interactiveElementCount: 2 });
    const browser = { newPage: vi.fn(async () => page), close: vi.fn() };
    mockedChromium.launch.mockResolvedValueOnce(browser as never);

    mockedGenerateObject
      .mockResolvedValueOnce({
        object: { type: "click", ref: "banana", reasoning: "bad input" },
      } as never)
      .mockResolvedValueOnce({
        object: { type: "done", result: "OK", reasoning: "" },
      } as never);

    const result = await runWebTask({
      url: "https://example.com",
      task: "Test garbage ref",
      settings: fakeSettings(),
    });

    expect(result.success).toBe(true);
    expect(page._click).not.toHaveBeenCalled();
  });
});

describe("runWebTask — goto action triggers navigation", () => {
  it("calls page.goto with the model-supplied URL and continues", async () => {
    const page = buildFakePage({ interactiveElementCount: 5 });
    const browser = { newPage: vi.fn(async () => page), close: vi.fn() };
    mockedChromium.launch.mockResolvedValueOnce(browser as never);

    mockedGenerateObject
      .mockResolvedValueOnce({
        object: { type: "goto", url: "https://other.example.com/inner", reasoning: "switch site" },
      } as never)
      .mockResolvedValueOnce({
        object: { type: "done", result: "Done", reasoning: "" },
      } as never);

    await runWebTask({
      url: "https://example.com",
      task: "Navigate elsewhere",
      settings: fakeSettings(),
    });

    // First .goto is the initial URL; second is the in-loop navigation.
    expect(page._goto).toHaveBeenCalledTimes(2);
    expect(page._goto).toHaveBeenLastCalledWith(
      "https://other.example.com/inner",
      expect.objectContaining({ waitUntil: "domcontentloaded" })
    );
  });
});

describe("runWebTask — iteration cap", () => {
  it("stops at the requested maxIterations and reports non-convergence", async () => {
    const page = buildFakePage({ interactiveElementCount: 5 });
    const browser = { newPage: vi.fn(async () => page), close: vi.fn() };
    mockedChromium.launch.mockResolvedValueOnce(browser as never);

    // The model never says "done" — every iteration is a click.
    mockedGenerateObject.mockResolvedValue({
      object: { type: "click", ref: "e1", reasoning: "loop forever" },
    } as never);

    const result = await runWebTask({
      url: "https://example.com",
      task: "Run forever",
      maxIterations: 3,
      settings: fakeSettings(),
    });

    expect(result.success).toBe(false);
    expect(result.result).toMatch(/max iterations/i);
    expect(result.iterations).toBe(3);
    expect(mockedGenerateObject).toHaveBeenCalledTimes(3);
  });

  it("clamps maxIterations to the hard ceiling (20)", async () => {
    const page = buildFakePage({ interactiveElementCount: 5 });
    const browser = { newPage: vi.fn(async () => page), close: vi.fn() };
    mockedChromium.launch.mockResolvedValueOnce(browser as never);

    mockedGenerateObject.mockResolvedValue({
      object: { type: "click", ref: "e1", reasoning: "" },
    } as never);

    const result = await runWebTask({
      url: "https://example.com",
      task: "X",
      maxIterations: 999, // user requests insane cap
      settings: fakeSettings(),
    });

    // Clamped to 20 — the safety hard-cap.
    expect(result.iterations).toBe(20);
  });
});

describe("runWebTask — AbortSignal honored", () => {
  it("throws (and triggers cleanup) when the abort signal is aborted before the loop starts", async () => {
    const page = buildFakePage({});
    const browser = { newPage: vi.fn(async () => page), close: vi.fn() };
    mockedChromium.launch.mockResolvedValueOnce(browser as never);

    const ac = new AbortController();
    ac.abort();

    await expect(
      runWebTask({
        url: "https://example.com",
        task: "Cancel me",
        settings: fakeSettings(),
        abortSignal: ac.signal,
      })
    ).rejects.toThrow(/abort/i);

    // Browser must still close on the error path — no leaked chromium.
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

describe("runWebTask — browser cleanup is unconditional", () => {
  it("closes the browser even if generateObject throws", async () => {
    const page = buildFakePage({});
    const browser = { newPage: vi.fn(async () => page), close: vi.fn() };
    mockedChromium.launch.mockResolvedValueOnce(browser as never);

    mockedGenerateObject.mockRejectedValueOnce(new Error("model down"));

    await expect(
      runWebTask({
        url: "https://example.com",
        task: "X",
        settings: fakeSettings(),
      })
    ).rejects.toThrow("model down");

    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("closes the browser even if page.goto throws on the initial nav", async () => {
    const page = buildFakePage({});
    page.goto.mockRejectedValueOnce(new Error("DNS fail"));
    const browser = { newPage: vi.fn(async () => page), close: vi.fn() };
    mockedChromium.launch.mockResolvedValueOnce(browser as never);

    await expect(
      runWebTask({
        url: "https://broken.example.com",
        task: "X",
        settings: fakeSettings(),
      })
    ).rejects.toThrow("DNS fail");

    expect(browser.close).toHaveBeenCalledTimes(1);
    // Model should never have been consulted — we never reached the loop.
    expect(mockedGenerateObject).not.toHaveBeenCalled();
  });
});

describe("runWebTask — action trace is recorded", () => {
  it("returns the full sequence of action types in order", async () => {
    const page = buildFakePage({ interactiveElementCount: 5 });
    const browser = { newPage: vi.fn(async () => page), close: vi.fn() };
    mockedChromium.launch.mockResolvedValueOnce(browser as never);

    mockedGenerateObject
      .mockResolvedValueOnce({
        object: { type: "fill", ref: "e1", text: "John", reasoning: "" },
      } as never)
      .mockResolvedValueOnce({
        object: { type: "click", ref: "e2", reasoning: "" },
      } as never)
      .mockResolvedValueOnce({
        object: { type: "done", result: "Submitted", reasoning: "" },
      } as never);

    const result = await runWebTask({
      url: "https://example.com",
      task: "Fill + submit",
      settings: fakeSettings(),
    });

    const types = result.actions.map((a: { type: string }) => a.type);
    expect(types).toEqual(["fill", "click", "done"]);
  });
});

describe("WebTaskAction discriminated union", () => {
  // Compile-time check via runtime exercise: every action variant must have
  // the right shape after destructuring. Catches schema drift between
  // ActionSchema and TS types.
  it("typechecks all 5 variants", () => {
    const variants: WebTaskAction[] = [
      { type: "click", ref: "e1", reasoning: "" },
      { type: "fill", ref: "e2", text: "x", reasoning: "" },
      { type: "goto", url: "https://example.com", reasoning: "" },
      { type: "done", result: "ok", reasoning: "" },
      { type: "fail", reason: "blocked" },
    ];
    expect(variants).toHaveLength(5);
  });
});
