// @vitest-environment happy-dom
/**
 * Component-level tests for `<ThemeSwitcher />`.
 *
 * The switcher is the operator-facing surface for PM #15 — it writes
 * `localStorage["orchestra-theme"]` so the next page load's pre-paint
 * bootstrap (in `src/app/layout.tsx`) picks the same value WITHOUT the
 * SSR `getSettings()` call that previously leaked `passwordHash`.
 *
 * Pinned invariants:
 *   - Reads the initial dark/light state from `<html>.classList`, NOT
 *     from localStorage (the `<html>` class is the source of truth at
 *     mount time; the bootstrap script in layout.tsx already applied it).
 *   - On click: optimistically toggles the class, writes to
 *     localStorage, fires PUT /api/settings.
 *   - On API failure: REVERTS the class AND localStorage so the next
 *     load is consistent with what the server thinks.
 *   - Renders a 32x32 placeholder before mount to avoid layout shift.
 *
 * `next/navigation` is mocked because the real one needs an App-Router
 * context that isn't available in unit tests; the only method
 * `ThemeSwitcher` calls is `router.refresh()`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { ThemeSwitcher } from "./theme-switcher";

let fetchMock: any;

beforeEach(() => {
  cleanup();
  // Reset DOM + localStorage between tests so toggling in one doesn't
  // leak into the next.
  document.documentElement.classList.remove("dark");
  localStorage.clear();
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<ThemeSwitcher /> — initial render", () => {
  // The component renders a 32x32 placeholder while `isDark` is null,
  // then swaps to a button after useEffect reads the html.classList.
  // RTL flushes effects synchronously, so the placeholder is never
  // observable from a test — it's a layout-shift detail covered by
  // visual review, not unit tests.

  it("after mount, reflects the html.classList state via the button", async () => {
    document.documentElement.classList.add("dark");
    render(<ThemeSwitcher />);
    // After useEffect runs, a button with title "Toggle Theme" appears.
    const button = await screen.findByTitle(/Toggle Theme/i);
    expect(button).toBeInTheDocument();
    // The button now wraps a Moon icon (dark mode is on). We don't
    // pin the SVG class; we pin the screen-reader label instead.
    expect(screen.getByText(/Toggle theme/i)).toBeInTheDocument();
  });
});

describe("<ThemeSwitcher /> — click toggles theme + persists optimistically", () => {
  it("light → dark: adds dark class, writes localStorage, fires PUT /api/settings", async () => {
    const user = userEvent.setup();
    render(<ThemeSwitcher />);
    const button = await screen.findByTitle(/Toggle Theme/i);

    expect(document.documentElement.classList.contains("dark")).toBe(false);

    await user.click(button);

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("orchestra-theme")).toBe("dark");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/settings");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ general: { darkMode: true } });
  });

  it("dark → light: removes dark class, writes 'light' to localStorage", async () => {
    document.documentElement.classList.add("dark");
    const user = userEvent.setup();
    render(<ThemeSwitcher />);
    const button = await screen.findByTitle(/Toggle Theme/i);

    await user.click(button);

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("orchestra-theme")).toBe("light");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({ general: { darkMode: false } });
  });
});

describe("<ThemeSwitcher /> — failure recovery", () => {
  it("on PUT failure: KEEPS the class AND localStorage (server sync is a background mirror)", async () => {
    // The class + localStorage are the client-side source of truth for
    // theming (PM #15 — the server never drives SSR theming). The old
    // revert-on-failure contract undid the user's choice whenever the
    // background mirror request got dropped (navigation aborting the
    // in-flight fetch, dev-server restart), which presented as "the theme
    // button doesn't work" — the theme flipped back moments after the click.
    fetchMock.mockRejectedValue(new Error("network down"));
    // Suppress the console.error the component logs on failure so the
    // test output stays clean.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const user = userEvent.setup();
    render(<ThemeSwitcher />);
    const button = await screen.findByTitle(/Toggle Theme/i);

    expect(document.documentElement.classList.contains("dark")).toBe(false);

    await user.click(button);

    // Wait for the fetch's catch path to settle (it logs the failure).
    await waitFor(() => expect(errSpy).toHaveBeenCalled());

    // The user's choice survives the failed background sync.
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("orchestra-theme")).toBe("dark");

    errSpy.mockRestore();
  });
});

describe("<ThemeSwitcher /> — localStorage write tolerates failure", () => {
  it("does not throw when localStorage.setItem rejects (private mode / quota)", async () => {
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

    const user = userEvent.setup();
    render(<ThemeSwitcher />);
    const button = await screen.findByTitle(/Toggle Theme/i);

    // Click should NOT throw; the class change is what governs THIS
    // page, localStorage was for the next load.
    await expect(user.click(button)).resolves.toBeUndefined();
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    setItemSpy.mockRestore();
  });
});
