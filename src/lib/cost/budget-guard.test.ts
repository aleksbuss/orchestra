/**
 * Tests for `enforceChatBudget` — the shared budget gate every non-route
 * entry-point now calls (Telegram external relay, cron service,
 * subordinate agent, auto-pilot daemon).
 *
 * Strategy: mock the dynamic-imported `getSettings` + `getChat` so we
 * don't touch the real filesystem.
 *
 * Pinned invariants:
 *   - No cap configured → returns silently (no throw).
 *   - Cap configured + chat under cap → returns silently.
 *   - Cap configured + chat AT or OVER cap → throws ChatBudgetExceededError.
 *   - Empty chatId → returns silently (defensive).
 *   - Settings read failure → returns silently with a warn (DO NOT throw;
 *     missing settings shouldn't break LLM calls — the soft banner is the
 *     safety net).
 *   - Chat read failure → returns silently with a warn.
 *   - cap=0 / negative / NaN / Infinity → all treated as "no cap" (matches
 *     accumulator.ts checkChatBudget semantics).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSettingsMock, getChatMock } = vi.hoisted(() => ({
  getSettingsMock: vi.fn(),
  getChatMock: vi.fn(),
}));

vi.mock("@/lib/storage/settings-store", () => ({
  getSettings: (...args: unknown[]) => getSettingsMock(...args),
}));

vi.mock("@/lib/storage/chat-store", () => ({
  getChat: (...args: unknown[]) => getChatMock(...args),
}));

import {
  ChatBudgetExceededError,
  enforceChatBudget,
} from "./budget-guard";

let warnSpy = vi.spyOn(console, "warn");

beforeEach(() => {
  getSettingsMock.mockReset();
  getChatMock.mockReset();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("enforceChatBudget — no-op paths", () => {
  it("returns silently when chatId is empty", async () => {
    await expect(enforceChatBudget("")).resolves.toBeUndefined();
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it("returns silently when no cap is configured (undefined)", async () => {
    getSettingsMock.mockResolvedValue({ costGuard: undefined });
    await expect(enforceChatBudget("c-1")).resolves.toBeUndefined();
    // No chat read either — short-circuit before the chat-store import.
    expect(getChatMock).not.toHaveBeenCalled();
  });

  it("returns silently when cap is 0 / negative / NaN / Infinity", async () => {
    for (const cap of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      getSettingsMock.mockResolvedValueOnce({ costGuard: { maxUsdPerChat: cap } });
      await expect(enforceChatBudget("c-1")).resolves.toBeUndefined();
    }
    expect(getChatMock).not.toHaveBeenCalled();
  });

  it("returns silently when chat is under cap", async () => {
    getSettingsMock.mockResolvedValue({ costGuard: { maxUsdPerChat: 5.0 } });
    getChatMock.mockResolvedValue({
      cumulativeUsage: {
        promptTokens: 100,
        completionTokens: 50,
        costUsd: 2.5,
        fullyPriced: true,
      },
    });
    await expect(enforceChatBudget("c-1")).resolves.toBeUndefined();
  });

  it("returns silently when chat has no cumulativeUsage yet (fresh chat)", async () => {
    getSettingsMock.mockResolvedValue({ costGuard: { maxUsdPerChat: 5.0 } });
    getChatMock.mockResolvedValue({ id: "c-1", messages: [] });
    await expect(enforceChatBudget("c-1")).resolves.toBeUndefined();
  });
});

describe("enforceChatBudget — cap-exceeded throws", () => {
  it("throws ChatBudgetExceededError when cost === cap (>= semantics)", async () => {
    getSettingsMock.mockResolvedValue({ costGuard: { maxUsdPerChat: 5.0 } });
    getChatMock.mockResolvedValue({
      cumulativeUsage: { costUsd: 5.0, fullyPriced: true },
    });
    await expect(enforceChatBudget("c-1")).rejects.toBeInstanceOf(
      ChatBudgetExceededError
    );
  });

  it("throws when cost > cap", async () => {
    getSettingsMock.mockResolvedValue({ costGuard: { maxUsdPerChat: 5.0 } });
    getChatMock.mockResolvedValue({
      cumulativeUsage: { costUsd: 7.42, fullyPriced: true },
    });
    await expect(enforceChatBudget("c-1")).rejects.toThrow(/exceeded/);
  });

  it("error carries costUsd + maxUsdPerChat (callers can map to 402)", async () => {
    getSettingsMock.mockResolvedValue({ costGuard: { maxUsdPerChat: 5.0 } });
    getChatMock.mockResolvedValue({
      cumulativeUsage: { costUsd: 9.99, fullyPriced: true },
    });
    try {
      await enforceChatBudget("c-1");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ChatBudgetExceededError);
      expect((err as ChatBudgetExceededError).costUsd).toBe(9.99);
      expect((err as ChatBudgetExceededError).maxUsdPerChat).toBe(5.0);
    }
  });

  it("enforces the cap even when fullyPriced=false (lower-bound at cap)", async () => {
    getSettingsMock.mockResolvedValue({ costGuard: { maxUsdPerChat: 5.0 } });
    getChatMock.mockResolvedValue({
      cumulativeUsage: { costUsd: 5.0, fullyPriced: false },
    });
    await expect(enforceChatBudget("c-1")).rejects.toBeInstanceOf(
      ChatBudgetExceededError
    );
  });
});

describe("enforceChatBudget — failure modes (NEVER throws non-budget errors)", () => {
  it("settings read failure → returns silently, logs warn", async () => {
    getSettingsMock.mockRejectedValue(new Error("settings.json corrupt"));
    await expect(enforceChatBudget("c-1")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/budget-guard.*settings/i),
      expect.any(String)
    );
    // Chat-store should NOT be reached when settings read fails.
    expect(getChatMock).not.toHaveBeenCalled();
  });

  it("chat read failure → returns silently, logs warn", async () => {
    getSettingsMock.mockResolvedValue({ costGuard: { maxUsdPerChat: 5.0 } });
    getChatMock.mockRejectedValue(new Error("chat-store boom"));
    await expect(enforceChatBudget("c-1")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/budget-guard.*chat/i),
      expect.any(String)
    );
  });

  it("getChat returning null → returns silently (fresh-chat path)", async () => {
    getSettingsMock.mockResolvedValue({ costGuard: { maxUsdPerChat: 5.0 } });
    getChatMock.mockResolvedValue(null);
    await expect(enforceChatBudget("c-1")).resolves.toBeUndefined();
  });
});
