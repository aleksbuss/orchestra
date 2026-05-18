// @vitest-environment happy-dom
/**
 * Component-level tests for `<ChatErrorBanner />` — the visible surface
 * for the chat-error SSE event. These tests run under the happy-dom
 * environment (per-file directive above) so we have a real DOM tree
 * for assertions on rendered text, button clicks, accessibility roles.
 *
 * Pure-logic coverage already lives in `chat-error-banner.test.ts`
 * (`styleForKind`). This file pins the RENDER + INTERACTION behavior:
 *   - The banner uses `role="alert"` + `aria-live="assertive"` so screen
 *     readers announce server-side failures immediately.
 *   - Hint and trace-id render only when set on the payload.
 *   - The dismiss button triggers `onDismiss`.
 *   - The copy button calls `navigator.clipboard.writeText` with the
 *     full trace id (NOT just the 8-char prefix shown in the label) and
 *     flips the label to "copied" for ~1.5s, then back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatErrorBanner } from "./chat-error-banner";
import type { ChatErrorPayload } from "@/lib/realtime/types";

const samplePayload: ChatErrorPayload = {
  traceId: "trace-1234abcd-5678efgh",
  kind: "upstream_no_tools",
  message: "The selected chat model doesn't support tool calling.",
  hint: "Switch to gpt-4o-mini.",
  recoverable: false,
};

/**
 * happy-dom defines `navigator.clipboard` as a non-configurable getter,
 * so plain `Object.assign(navigator, { clipboard: ... })` throws once
 * the getter has been accessed. `Object.defineProperty` with
 * `configurable: true` lets us swap it per test.
 */
function installClipboardMock(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

beforeEach(() => {
  cleanup();
});

describe("<ChatErrorBanner /> — rendering", () => {
  it("renders the kind-derived label, message, and optional hint", () => {
    render(<ChatErrorBanner error={samplePayload} onDismiss={() => {}} />);
    // Label comes from `styleForKind`; "Model can't call tools" is the
    // upstream_no_tools label.
    expect(screen.getByText(/Model can't call tools/i)).toBeInTheDocument();
    expect(
      screen.getByText(/The selected chat model doesn't support tool calling/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/Switch to gpt-4o-mini/)).toBeInTheDocument();
  });

  it("omits the hint paragraph when payload.hint is undefined", () => {
    render(
      <ChatErrorBanner
        error={{ ...samplePayload, hint: undefined }}
        onDismiss={() => {}}
      />
    );
    // The italic hint text is gone, but the message stays.
    expect(screen.queryByText(/Switch to gpt-4o-mini/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/The selected chat model doesn't support tool calling/i)
    ).toBeInTheDocument();
  });

  it("uses role=alert + aria-live=assertive for screen-reader-friendly delivery", () => {
    render(<ChatErrorBanner error={samplePayload} onDismiss={() => {}} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("shows the trace id (truncated to 8 chars) on the copy button", () => {
    render(<ChatErrorBanner error={samplePayload} onDismiss={() => {}} />);
    // Initial label: "trace " + first 8 chars of "trace-1234abcd-5678efgh".
    const button = screen.getByTitle(/Copy trace id/i);
    expect(button.textContent).toMatch(/trace trace-12/);
  });

  it("hides the trace-id button entirely when traceId is missing", () => {
    render(
      <ChatErrorBanner
        error={{ ...samplePayload, traceId: undefined }}
        onDismiss={() => {}}
      />
    );
    expect(screen.queryByTitle(/Copy trace id/i)).not.toBeInTheDocument();
  });
});

describe("<ChatErrorBanner /> — interactions", () => {
  it("clicking the X button calls onDismiss exactly once", async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<ChatErrorBanner error={samplePayload} onDismiss={onDismiss} />);

    await user.click(screen.getByLabelText(/Dismiss/i));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("copy button writes the FULL trace id to the clipboard", async () => {
    // user-event installs its own clipboard wrapper during `setup()`;
    // our explicit mock has to land AFTER that, otherwise user-event's
    // wrapper replaces ours and we never see the write.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboardMock(writeText);

    render(<ChatErrorBanner error={samplePayload} onDismiss={() => {}} />);

    await user.click(screen.getByTitle(/Copy trace id/i));

    expect(writeText).toHaveBeenCalledOnce();
    // The label shows only the 8-char prefix; the clipboard MUST receive
    // the full id so the operator can grep server logs by it.
    expect(writeText).toHaveBeenCalledWith("trace-1234abcd-5678efgh");
  });

  it("copy button flips its label to 'copied' after a successful write", async () => {
    installClipboardMock(vi.fn().mockResolvedValue(undefined));
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ChatErrorBanner error={samplePayload} onDismiss={() => {}} />);

    const button = screen.getByTitle(/Copy trace id/i);
    await user.click(button);

    // The post-click label is "copied"; user.click already awaited the
    // setState that swapped it.
    expect(button.textContent).toMatch(/copied/);

    // After 1.5s the original label comes back. We control the timer so
    // the test is deterministic — without fake timers this would be
    // flaky in CI under load.
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    expect(button.textContent).toMatch(/trace trace-12/);

    vi.useRealTimers();
  });

  it("copy button does NOT crash when clipboard.writeText rejects (insecure context, denied permission)", async () => {
    installClipboardMock(vi.fn().mockRejectedValue(new Error("permission denied")));

    const user = userEvent.setup();
    render(<ChatErrorBanner error={samplePayload} onDismiss={() => {}} />);

    const button = screen.getByTitle(/Copy trace id/i);
    // Should not throw; failure path swallows the rejection silently
    // since the trace id is also visible in the DOM as a fallback.
    await expect(user.click(button)).resolves.toBeUndefined();
  });
});

describe("<ChatErrorBanner /> — kind variants render distinct visual styling", () => {
  it("rate-limit gets the amber 'Rate limited' label", () => {
    render(
      <ChatErrorBanner
        error={{ ...samplePayload, kind: "upstream_rate_limit" }}
        onDismiss={() => {}}
      />
    );
    expect(screen.getByText(/Rate limited/i)).toBeInTheDocument();
  });

  it("abort gets the muted 'Request cancelled' label", () => {
    render(
      <ChatErrorBanner
        error={{ ...samplePayload, kind: "abort" }}
        onDismiss={() => {}}
      />
    );
    expect(screen.getByText(/Request cancelled/i)).toBeInTheDocument();
  });

  it("internal error falls back to the red 'Internal error' label", () => {
    render(
      <ChatErrorBanner
        error={{ ...samplePayload, kind: "internal" }}
        onDismiss={() => {}}
      />
    );
    expect(screen.getByText(/Internal error/i)).toBeInTheDocument();
  });
});
