// @vitest-environment happy-dom
/**
 * Component-level tests for `<SkepticSelector />` — the per-request Skeptic
 * model picker in the swarm panel.
 *
 * The whole point of the 2026-07 rework was to let the operator pick ANY model
 * of ANY accepted provider as the Skeptic (previously the panel only offered a
 * quick-switch among already-configured models — the "only DeepSeek" report).
 * These pin the wire that unit-less inspection misses:
 *   1. No override → shows "Inherit".
 *   2. The provider list is exactly the server-accepted set (`SKEPTIC_PROVIDERS`)
 *      — crucially NOT the CLI providers, which `isValidSkepticOverride` 400s.
 *   3. "Inherit Settings" clears the sticky override back to null.
 *   4. Picking a model from the fetched catalog commits `{provider, model}` to
 *      the store — the actual per-request override the backend consumes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SkepticSelector } from "./skeptic-selector";
import { SKEPTIC_PROVIDERS } from "@/components/settings/model-wizards";
import { useAppStore } from "@/store/app-store";

const FAKE_SETTINGS = {
  chatModel: { provider: "openrouter", model: "x" },
  utilityModel: { provider: "openrouter", model: "y" },
  providerApiKeys: {},
  envApiKeys: {},
};

const FAKE_MODELS = [
  { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
  { id: "anthropic/claude-3-5-sonnet", name: "Claude 3.5 Sonnet" },
];

beforeEach(() => {
  cleanup();
  useAppStore.setState({ skepticModelOverride: null });
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/settings")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(FAKE_SETTINGS) });
    }
    if (url.startsWith("/api/models")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ models: FAKE_MODELS }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("<SkepticSelector />", () => {
  it("shows 'Inherit' when no override is set", () => {
    render(<SkepticSelector />);
    expect(screen.getByRole("button", { name: /skeptic model override/i }).textContent).toContain(
      "Inherit"
    );
  });

  it("offers exactly the server-accepted providers — and NOT the CLI providers", async () => {
    render(<SkepticSelector />);
    await userEvent.click(screen.getByRole("button", { name: /skeptic model override/i }));
    const select = (await screen.findByLabelText("Skeptic provider")) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual([...SKEPTIC_PROVIDERS]);
    expect(values).not.toContain("codex-cli");
    expect(values).not.toContain("gemini-cli");
  });

  it("'Inherit Settings' clears a sticky override", async () => {
    useAppStore.setState({
      skepticModelOverride: { provider: "openrouter", model: "deepseek/deepseek-chat" },
    });
    render(<SkepticSelector />);
    await userEvent.click(screen.getByRole("button", { name: /skeptic model override/i }));
    await userEvent.click(screen.getByRole("button", { name: /inherit settings/i }));
    expect(useAppStore.getState().skepticModelOverride).toBeNull();
  });

  it("shows an error + retry (not an indefinite 'Loading…') when the settings fetch fails", async () => {
    // Reject the settings fetch outright — the failure path the swallowed
    // `.catch(() => {})` used to strand on "Loading…" forever. This test fails
    // if the component regresses to swallowing the error.
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/settings")) {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    }) as unknown as typeof fetch;

    render(<SkepticSelector />);
    await userEvent.click(screen.getByRole("button", { name: /skeptic model override/i }));

    // Error affordance appears...
    expect(await screen.findByRole("button", { name: /retry/i })).toBeTruthy();
    // ...and it is NOT stuck on the loading placeholder.
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it("picking a model from the catalog commits {provider, model} to the store", async () => {
    render(<SkepticSelector />);
    await userEvent.click(screen.getByRole("button", { name: /skeptic model override/i }));
    // Open the searchable model dropdown, wait for the fetched catalog, pick one.
    // The display name may carry a curated emoji prefix (⭐/💻/…) — match the
    // stable substring; the committed value is keyed on the untouched model id.
    await userEvent.click(await screen.findByText(/select a model/i));
    await userEvent.click(await screen.findByText(/DeepSeek Chat/));
    await waitFor(() => {
      expect(useAppStore.getState().skepticModelOverride).toEqual({
        provider: "openrouter",
        model: "deepseek/deepseek-chat",
      });
    });
  });
});
