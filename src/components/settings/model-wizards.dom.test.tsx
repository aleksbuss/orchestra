// @vitest-environment happy-dom
/**
 * Component-level tests for the model-config wizards (`model-wizards.tsx`,
 * 988 LOC — the largest untested component, QA audit F-03).
 *
 * `ChatModelWizard` / `UtilityModelWizard` are thin wrappers over the shared
 * `ModelConfigWizard`, each delegating with a distinct `configKey` + `title`.
 * We pin that delegation: each wrapper renders ITS title (and therefore reads
 * its own model config), not the other's. Rendering also drives the ~400-LOC
 * `ModelConfigWizard` body (provider/model selects, auth + connection UI),
 * which was entirely uncovered. The provider/model `<select>` interactions and
 * the connection check are a follow-up.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ChatModelWizard, UtilityModelWizard } from "./model-wizards";
import type { AppSettings } from "@/lib/types";

// useModels (in-file) fetches the provider's model list on render; an empty
// payload keeps it from erroring without affecting the title we assert on.
function stubModelsFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ models: [] }) }) as unknown as Response)
  );
}

function settings(): AppSettings {
  return {
    chatModel: { provider: "openai", model: "gpt-4o", apiKey: "", authMethod: "api_key" },
    utilityModel: { provider: "openai", model: "gpt-4o-mini", apiKey: "", authMethod: "api_key" },
    providerApiKeys: {},
    envApiKeys: {},
  } as unknown as AppSettings;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("model wizards — wrapper delegation (configKey/title)", () => {
  it("ChatModelWizard renders the chat-model title", () => {
    stubModelsFetch();
    render(<ChatModelWizard settings={settings()} updateSettings={vi.fn()} />);
    expect(screen.getByText("Chat Model (Orchestrator / Brain)")).toBeTruthy();
  });

  it("UtilityModelWizard renders the DISTINCT utility-model title", () => {
    stubModelsFetch();
    render(<UtilityModelWizard settings={settings()} updateSettings={vi.fn()} />);
    expect(screen.getByText("Swarm Worker Model (Background & Agents)")).toBeTruthy();
    // It must NOT render the chat-model title — proves it delegates with its
    // own configKey, not chatModel's.
    expect(screen.queryByText("Chat Model (Orchestrator / Brain)")).toBeNull();
  });
});
