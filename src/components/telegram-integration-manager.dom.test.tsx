// @vitest-environment happy-dom
/**
 * Component-level tests for `<TelegramIntegrationManager />` — the Settings
 * panel that connects/disconnects the Telegram bot. Render coverage for a
 * previously-untested 569-LOC component (QA audit F-03).
 *
 * We pin the connection-state contract: the panel reads `/api/integrations/
 * telegram/config` on mount and shows the "connected" copy only when BOTH a
 * token source and a public base URL are configured, otherwise the setup
 * prompt. Getting this wrong means the operator can't tell whether the bot is
 * live. The connect/disconnect/webhook mutations are a follow-up.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TelegramIntegrationManager } from "./telegram-integration-manager";

function stubTelegramFetch(config: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes("/telegram/config")) {
      return { ok: true, json: async () => config } as unknown as Response;
    }
    // webhook status + anything else: harmless empty payload.
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const connectedConfig = {
  botToken: "12345:AAmasked",
  publicBaseUrl: "https://bot.example.com",
  sources: { botToken: "settings" },
  allowedUserIds: [],
  pendingAccessCodes: 0,
  updatedAt: null,
};

const unconfigured = {
  botToken: "",
  publicBaseUrl: "",
  sources: { botToken: "none" },
  allowedUserIds: [],
  pendingAccessCodes: 0,
  updatedAt: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("<TelegramIntegrationManager /> — connection state from config", () => {
  it("shows the connected copy after the mount-fetch returns a token + base URL", async () => {
    stubTelegramFetch(connectedConfig);

    render(<TelegramIntegrationManager />);

    // This copy renders only when isConnected (token source !== "none" AND a
    // public base URL) — i.e. only after the config fetch resolves.
    expect(await screen.findByText(/Telegram is connected/i)).toBeTruthy();
  });

  it("shows the setup prompt and fetches config when nothing is configured", async () => {
    const fetchMock = stubTelegramFetch(unconfigured);

    render(<TelegramIntegrationManager />);

    expect(
      await screen.findByText(/Enter the bot token and Public Base URL/i)
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integrations/telegram/config",
      expect.anything()
    );
  });
});
