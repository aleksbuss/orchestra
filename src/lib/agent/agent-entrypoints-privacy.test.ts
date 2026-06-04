/**
 * PM #47 — Privacy Mode air-gap must hold on EVERY LLM entry point, not just
 * the interactive `runAgent`. Review bug_008 found two parallel entry paths
 * that skipped `assertPrivacyModeAllowsSettings`:
 *
 *   - `runAgentText`        — cron jobs + the (unauthenticated) Telegram webhook
 *   - `runSubordinateAgent` — call_subordinate, incl. the recursive path
 *
 * With Privacy Mode ON + a cloud `chatModel`, the interactive chat correctly
 * refused, but every cron tick and every Telegram message silently shipped
 * user data to OpenAI/Anthropic/Google. These tests pin the invariant that
 * BOTH entry points throw BEFORE reaching `createModel`/`generateText`.
 *
 * Mechanism: we mock `getSettings` to return privacy-on + a cloud chatModel.
 * The guard runs immediately after `getSettings`, so the throw happens before
 * any model is created — no SDK/network mock needed.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppSettings } from "@/lib/types";

const cloudPrivacySettings: AppSettings = {
  privacyMode: { enabled: true },
  chatModel: { provider: "openai", model: "gpt-4o", apiKey: "sk-test" },
  utilityModel: { provider: "ollama", model: "qwen2.5:3b" },
  embeddingsModel: { provider: "ollama", model: "nomic-embed-text", dimensions: 768 },
  codeExecution: { enabled: true, timeout: 600, maxOutputLength: 120000 },
  memory: { enabled: true, similarityThreshold: 0.35, maxResults: 10, chunkSize: 400 },
  search: { enabled: false, provider: "none" },
  general: { darkMode: false, language: "en" },
  auth: {
    enabled: true,
    username: "admin",
    passwordHash: "scrypt$x$y",
    mustChangeCredentials: false,
  },
};

vi.mock("@/lib/storage/settings-store", () => ({
  getSettings: vi.fn(async () => cloudPrivacySettings),
}));

import { runAgentText, runSubordinateAgent } from "./agent";

describe("PM #47 — Privacy Mode enforced on non-interactive LLM entry points (bug_008)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runAgentText (cron / Telegram path) throws before reaching the model", async () => {
    await expect(
      runAgentText({ chatId: "cron-1", userMessage: "summarize my inbox" })
    ).rejects.toThrow(/Privacy Mode is enabled/);
  });

  it("runSubordinateAgent (call_subordinate path) throws before reaching the model", async () => {
    await expect(
      runSubordinateAgent({
        task: "do a subtask",
        parentAgentNumber: 0,
        parentHistory: [],
      })
    ).rejects.toThrow(/Privacy Mode is enabled/);
  });
});
