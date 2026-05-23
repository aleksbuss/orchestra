/**
 * Integration test for the `web_task` tool against a REAL Playwright instance
 * driving a local HTML fixture.
 *
 * What this catches that the unit test doesn't:
 *   - The actual accessibility snapshot path (Playwright `.locator(...).all()`
 *     on a real DOM, not a mocked array). A change to the selector list in
 *     `takeSnapshot` would silently break unit tests' fake page but explode
 *     here against a real document.
 *   - The ref → locator round-trip: snapshot assigns `@e1`, `@e2`, ..., and
 *     the loop must be able to resolve them back to the same elements.
 *     Off-by-one or selector-list-order regressions die here.
 *   - Browser launch + close on the real binary. Catches Playwright API
 *     drift if a Chromium upgrade renames a method.
 *
 * What we DON'T test here:
 *   - The LLM decision. The model is still mocked — testing the inner LLM
 *     loop against a real model would be flaky + expensive. The model's
 *     scripted actions are predetermined.
 *
 * Cost: each test spins up a real headless Chromium. ~1-3 sec per test.
 * Marked with a vitest timeout of 30s for slow CI envs.
 *
 * Requires `npx playwright install chromium` (one-time setup; CI configs
 * already do this for the existing e2e suite).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import os from "os";

// Mock the AI SDK so we script the model's actions; everything else (the
// real `playwright` package, the real LLM provider factory) is left intact.
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateObject: vi.fn(),
  };
});

vi.mock("@/lib/providers/llm-provider", () => ({
  createModel: vi.fn(() => ({})),
}));

import { runWebTask } from "./web-task";
import { generateObject } from "ai";
import type { AppSettings } from "@/lib/types";

const mockedGenerateObject = vi.mocked(generateObject);

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

// Build a self-contained HTML fixture as a `file://` URL so Playwright can
// open it without a local server. Each test gets its own temp file.
async function fixtureUrl(html: string): Promise<{ url: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-webtask-"));
  const file = path.join(dir, "fixture.html");
  await fs.writeFile(file, html, "utf-8");
  return {
    url: `file://${file}`,
    cleanup: async () => {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("web_task — integration against real Playwright (local fixture)", () => {
  // Skip when Playwright's chromium binary is missing — common on CI runners
  // that haven't done `npx playwright install`. Better than a noisy fail.
  const chromiumPath = path.join(
    os.homedir(),
    "Library/Caches/ms-playwright"
  );
  const _hasChromium = fs.access(chromiumPath).then(
    () => true,
    () => false
  );

  it(
    "opens a real page, lists interactive elements, completes a done task",
    async () => {
      if (!(await _hasChromium)) {
        console.warn("[web-task.integration] chromium not installed; skipping");
        return;
      }

      const { url, cleanup } = await fixtureUrl(`
        <!DOCTYPE html>
        <html><head><title>Pricing</title></head>
        <body>
          <h1>Plans</h1>
          <button id="basic">Basic — $9</button>
          <button id="pro">Pro — $29</button>
          <button id="ent">Enterprise — Contact us</button>
        </body></html>
      `);

      try {
        // Script: model immediately says "done" with the answer.
        mockedGenerateObject.mockResolvedValueOnce({
          object: {
            type: "done",
            result: "Cheapest plan: Basic at $9/mo",
            reasoning: "answer is visible on the page",
          },
        } as never);

        const result = await runWebTask({
          url,
          task: "Find the cheapest plan price",
          settings: fakeSettings(),
        });

        expect(result.success).toBe(true);
        expect(result.result).toContain("Basic");
        expect(result.iterations).toBe(1);
      } finally {
        await cleanup();
      }
    },
    30_000
  );

  it(
    "resolves snapshot refs back to real DOM elements (click works end-to-end)",
    async () => {
      if (!(await _hasChromium)) {
        console.warn("[web-task.integration] chromium not installed; skipping");
        return;
      }

      // Page with a button that, when clicked, swaps the body content. After
      // the click + next snapshot, the model "sees" the new content.
      const { url, cleanup } = await fixtureUrl(`
        <!DOCTYPE html>
        <html><head><title>Click Test</title></head>
        <body>
          <button onclick="document.body.innerHTML='<p id=after>CLICKED</p>'">Tap</button>
        </body></html>
      `);

      try {
        // Iter 1: click @e1 (the only button). Iter 2: done.
        mockedGenerateObject
          .mockResolvedValueOnce({
            object: { type: "click", ref: "e1", reasoning: "tap the button" },
          } as never)
          .mockResolvedValueOnce({
            object: { type: "done", result: "Clicked", reasoning: "" },
          } as never);

        const result = await runWebTask({
          url,
          task: "Click the button",
          settings: fakeSettings(),
        });

        expect(result.success).toBe(true);
        // The model was asked twice — once before the click, once after.
        expect(result.iterations).toBe(2);
        expect(mockedGenerateObject).toHaveBeenCalledTimes(2);

        // The SECOND call should have a different snapshot in its prompt —
        // the post-click body. We inspect the prompt to confirm the
        // re-snapshot path actually re-read the DOM.
        const secondCallPrompt = (mockedGenerateObject.mock.calls[1][0] as { prompt: string })
          .prompt;
        expect(secondCallPrompt).toContain("CLICKED");
      } finally {
        await cleanup();
      }
    },
    30_000
  );

  it(
    "handles a fill action on a real input element",
    async () => {
      if (!(await _hasChromium)) {
        console.warn("[web-task.integration] chromium not installed; skipping");
        return;
      }

      const { url, cleanup } = await fixtureUrl(`
        <!DOCTYPE html>
        <html><head><title>Form</title></head>
        <body>
          <input type="email" placeholder="Email" id="email">
          <button>Submit</button>
          <script>
            document.querySelector('input').addEventListener('input', (e) => {
              document.title = 'Typed: ' + e.target.value;
            });
          </script>
        </body></html>
      `);

      try {
        mockedGenerateObject
          .mockResolvedValueOnce({
            object: { type: "fill", ref: "e1", text: "test@example.com", reasoning: "" },
          } as never)
          .mockResolvedValueOnce({
            object: { type: "done", result: "Filled", reasoning: "" },
          } as never);

        const result = await runWebTask({
          url,
          task: "Fill the email field",
          settings: fakeSettings(),
        });

        expect(result.success).toBe(true);
        // The page's onInput handler should have updated the title; we
        // verify the second snapshot prompt contains the new title.
        const secondPrompt = (mockedGenerateObject.mock.calls[1][0] as { prompt: string }).prompt;
        expect(secondPrompt).toContain("Typed: test@example.com");
      } finally {
        await cleanup();
      }
    },
    30_000
  );

  it(
    "handles a page with zero interactive elements without crashing",
    async () => {
      if (!(await _hasChromium)) {
        console.warn("[web-task.integration] chromium not installed; skipping");
        return;
      }

      const { url, cleanup } = await fixtureUrl(`
        <!DOCTYPE html>
        <html><head><title>Static</title></head>
        <body><p>Just text, no buttons or links.</p></body>
        </html>
      `);

      try {
        // Snapshot prompt should explicitly say "no interactive elements".
        // Model returns done with the read-only content as the result.
        mockedGenerateObject.mockResolvedValueOnce({
          object: { type: "done", result: "Page contains: 'Just text, no buttons or links.'", reasoning: "" },
        } as never);

        const result = await runWebTask({
          url,
          task: "Read the page content",
          settings: fakeSettings(),
        });

        expect(result.success).toBe(true);
        const promptArg = (mockedGenerateObject.mock.calls[0][0] as { prompt: string }).prompt;
        expect(promptArg).toMatch(/no interactive elements/i);
      } finally {
        await cleanup();
      }
    },
    30_000
  );
});
