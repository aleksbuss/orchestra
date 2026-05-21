// @vitest-environment happy-dom
/**
 * Component-level tests for `<SwarmConfig />`.
 *
 * This is the user's only handle on the MoA ensemble + Auto-Pilot + Force
 * Swarm modes. A regression here = "I clicked the toggle, nothing happened"
 * — the exact class of bug the 2026-05-20 audit caught (cheap utilityModel
 * silently overriding Swarm-ON).
 *
 * Pinned invariants:
 *   1. Swarm OFF by default? NO — the store default is ON. The button must
 *      reflect that on first render.
 *   2. Clicking Swarm flips state + the aria-pressed attribute. (Backend
 *      wiring is exercised by `src/app/api/chat/route.test.ts`.)
 *   3. The Force Swarm button is HIDDEN when Swarm is OFF — showing a
 *      "force" override for a feature that's off is UX-broken AND wires
 *      the user up to send `forceSwarm: true` against a backend that
 *      ignores it (no swarm to force).
 *   4. The Force Swarm button TOGGLES `forceSwarm` in the store on click.
 *      The Router-bypass behavior is exercised by `moa.test.ts`; here we
 *      pin the UI contract.
 *   5. Auto-Pilot is independent of Swarm — its visibility / toggle state
 *      does not depend on swarmEnabled.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The PresetSelector pulls in lots of icon + zustand machinery that we
// don't care about for this file. Stub it to keep the test focused.
vi.mock("./preset-selector", () => ({
  PresetSelector: () => <div data-testid="stub-preset-selector" />,
}));

import { SwarmConfig } from "./swarm-config";
import { useAppStore } from "@/store/app-store";

function resetStore() {
  // Reset toggles to the documented defaults so each test starts clean.
  // Other store fields are left alone — they don't affect SwarmConfig.
  useAppStore.setState({
    swarmEnabled: true,
    daemonMode: false,
    forceSwarm: false,
  });
}

beforeEach(() => {
  cleanup();
  resetStore();
});

describe("<SwarmConfig /> — initial render", () => {
  it("renders Swarm + Auto-Pilot buttons", () => {
    render(<SwarmConfig />);
    expect(screen.getByRole("button", { name: /toggle swarm mode/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /toggle auto-pilot mode/i })).toBeTruthy();
  });

  it("Swarm starts in pressed state (store default is ON)", () => {
    render(<SwarmConfig />);
    const swarm = screen.getByRole("button", { name: /toggle swarm mode/i });
    // aria-pressed = "true" is the accessibility contract; without it,
    // screen readers report the toggle as off when it's actually on.
    expect(swarm.getAttribute("aria-pressed")).toBe("true");
  });

  it("Auto-Pilot starts in NOT-pressed state (store default is OFF)", () => {
    render(<SwarmConfig />);
    const auto = screen.getByRole("button", { name: /toggle auto-pilot mode/i });
    expect(auto.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("<SwarmConfig /> — Swarm toggle", () => {
  it("clicking Swarm flips both store state AND aria-pressed", async () => {
    const user = userEvent.setup();
    render(<SwarmConfig />);

    const swarm = screen.getByRole("button", { name: /toggle swarm mode/i });
    expect(swarm.getAttribute("aria-pressed")).toBe("true");

    await user.click(swarm);

    // Store is the source of truth — assert it directly. The UI re-render
    // happens via Zustand's hook; the aria-pressed reflection is the visible
    // proof that the re-render actually mounted.
    expect(useAppStore.getState().swarmEnabled).toBe(false);
    expect(swarm.getAttribute("aria-pressed")).toBe("false");

    await user.click(swarm);
    expect(useAppStore.getState().swarmEnabled).toBe(true);
    expect(swarm.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("<SwarmConfig /> — Force Swarm visibility (2026-05-20)", () => {
  // The Force button is the UI override for the Router's bypass decision.
  // It MUST only appear when Swarm is on — otherwise clicking it would set
  // `forceSwarm: true` in a state where no swarm exists to be forced, which
  // is silently meaningless (the body flag gets ignored on the backend).

  it("Force button is hidden when Swarm is OFF", () => {
    act(() => {
      useAppStore.setState({ swarmEnabled: false });
    });
    render(<SwarmConfig />);
    expect(
      screen.queryByRole("button", { name: /force swarm/i })
    ).toBeNull();
  });

  it("Force button appears when Swarm is ON", () => {
    render(<SwarmConfig />);
    expect(
      screen.getByRole("button", { name: /force swarm/i })
    ).toBeTruthy();
  });

  it("turning Swarm OFF after a render hides the Force button", async () => {
    const user = userEvent.setup();
    render(<SwarmConfig />);

    // Sanity: visible at start.
    expect(screen.getByRole("button", { name: /force swarm/i })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /toggle swarm mode/i }));

    // After flipping Swarm off, the Force toggle disappears in the same render.
    expect(
      screen.queryByRole("button", { name: /force swarm/i })
    ).toBeNull();
  });
});

describe("<SwarmConfig /> — Force Swarm toggle behavior", () => {
  it("starts NOT pressed by default (store default is false)", () => {
    render(<SwarmConfig />);
    const force = screen.getByRole("button", { name: /force swarm/i });
    expect(force.getAttribute("aria-pressed")).toBe("false");
    expect(useAppStore.getState().forceSwarm).toBe(false);
  });

  it("clicking Force flips both store state AND aria-pressed", async () => {
    const user = userEvent.setup();
    render(<SwarmConfig />);

    const force = screen.getByRole("button", { name: /force swarm/i });
    await user.click(force);

    expect(useAppStore.getState().forceSwarm).toBe(true);
    expect(force.getAttribute("aria-pressed")).toBe("true");

    await user.click(force);
    expect(useAppStore.getState().forceSwarm).toBe(false);
    expect(force.getAttribute("aria-pressed")).toBe("false");
  });

  it("turning Swarm OFF does NOT auto-clear forceSwarm in the store", async () => {
    // This is intentional: forceSwarm is a user preference. Toggling Swarm
    // off should hide the button (no swarm to force) but preserve the value
    // so re-enabling Swarm restores the previous Force preference.
    const user = userEvent.setup();
    render(<SwarmConfig />);

    await user.click(screen.getByRole("button", { name: /force swarm/i }));
    expect(useAppStore.getState().forceSwarm).toBe(true);

    await user.click(screen.getByRole("button", { name: /toggle swarm mode/i }));
    // Force preference is preserved across Swarm OFF.
    expect(useAppStore.getState().forceSwarm).toBe(true);
  });
});

describe("<SwarmConfig /> — Auto-Pilot independence", () => {
  it("Auto-Pilot toggle works independently of Swarm state", async () => {
    const user = userEvent.setup();
    render(<SwarmConfig />);

    // Turn off Swarm first.
    await user.click(screen.getByRole("button", { name: /toggle swarm mode/i }));
    expect(useAppStore.getState().swarmEnabled).toBe(false);

    // Auto-Pilot button still works.
    await user.click(screen.getByRole("button", { name: /toggle auto-pilot mode/i }));
    expect(useAppStore.getState().daemonMode).toBe(true);
  });
});
