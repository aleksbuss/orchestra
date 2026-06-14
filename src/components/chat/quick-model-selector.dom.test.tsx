// @vitest-environment happy-dom
/**
 * Component-level tests for `<QuickModelSelector />` — the chat header control
 * that shows the active model and lets the user switch it inline.
 *
 * Establishes render coverage for a previously-untested 524-LOC component
 * (QA audit F-03 / F-22 follow-up). We pin the behavior most likely to regress
 * silently: on mount it fetches `/api/settings` and the trigger shows the
 * current model; and the `disabled` prop blocks switching (used mid-stream).
 *
 * NOTE (minor finding surfaced while writing this): the component's
 * `activePreset !== "custom"` branch (rendering `Preset: <name>`) is currently
 * DEAD — `PresetTier` (`@/lib/agent/presets`) is the single literal `"custom"`,
 * so the store value is always `"custom"` and the trigger always shows the
 * model. Left as cosmetic cleanup; not exercised here because the type forbids
 * constructing the other state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QuickModelSelector } from "./quick-model-selector";
import { useAppStore } from "@/store/app-store";

const initialState = useAppStore.getState();

function stubSettingsFetch(chatModel: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: unknown) => {
    if (String(url).includes("/api/settings")) {
      return { ok: true, json: async () => ({ chatModel }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  // Restore the pristine store snapshot (replace=true) before each test.
  useAppStore.setState(initialState, true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("<QuickModelSelector /> — mount + display contract", () => {
  it("on mount, fetches /api/settings and shows the current model in the trigger", async () => {
    const fetchMock = stubSettingsFetch({ provider: "openai", model: "gpt-4o" });

    render(<QuickModelSelector />);

    // The mount effect resolves settings → the trigger shows the model name.
    expect(await screen.findByText("gpt-4o")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/settings");
  });

  it("disables the trigger when the `disabled` prop is set (no switching mid-stream)", async () => {
    stubSettingsFetch({ provider: "openai", model: "gpt-4o" });

    render(<QuickModelSelector disabled />);

    // Closed dropdown → the only button is the trigger.
    await screen.findByText("gpt-4o");
    const trigger = screen.getByRole("button");
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
  });
});
