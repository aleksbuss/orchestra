/**
 * PM #33 regression tests — `filterAndPaginateChats` pure helper.
 *
 * Why pure-helper coverage: the actual `<SidebarChatList />` component depends
 * on `SidebarProvider` + shadcn context tree, which is heavy to set up for a
 * test that only validates math. The render shell of the component is
 * straightforward (renders `visible.map(...)`); the interesting logic — which
 * chats appear, in what order, how the "Show N more" line fires — lives
 * entirely in this helper.
 *
 * Behaviour pinned here:
 *   - No filter, ≤ limit chats: everything visible, no hidden tail.
 *   - No filter, > limit chats: first `limit` visible, rest counted.
 *   - Filter on: all matches visible regardless of limit (search beats pagination).
 *   - Filter with no matches: empty visible, zero hidden.
 *   - showAll bypasses pagination entirely.
 *   - Filter is case-insensitive; trims whitespace.
 *   - Chats with undefined title don't crash the matcher.
 */
import { describe, expect, it } from "vitest";
import { filterAndPaginateChats } from "./app-sidebar";

function makeChats(n: number, prefix: string = "chat"): Array<{ id: string; title: string }> {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    title: `${prefix}-${i}`,
  }));
}

describe("PM #33 — filterAndPaginateChats", () => {
  it("shows everything when chat count is below the limit", () => {
    const chats = makeChats(10);
    const out = filterAndPaginateChats(chats, "", false, 30);
    expect(out.visible).toHaveLength(10);
    expect(out.hiddenCount).toBe(0);
  });

  it("paginates when chat count exceeds the limit", () => {
    const chats = makeChats(100);
    const out = filterAndPaginateChats(chats, "", false, 30);
    expect(out.visible).toHaveLength(30);
    expect(out.hiddenCount).toBe(70);
  });

  it("showAll=true bypasses pagination", () => {
    const chats = makeChats(100);
    const out = filterAndPaginateChats(chats, "", true, 30);
    expect(out.visible).toHaveLength(100);
    expect(out.hiddenCount).toBe(0);
  });

  it("non-empty filter returns all matches (search beats pagination)", () => {
    const chats = [
      { id: "a", title: "alpha" },
      { id: "b", title: "beta" },
      { id: "c", title: "alpha-2" },
      ...makeChats(100, "noise"),
    ];
    const out = filterAndPaginateChats(chats, "alpha", false, 30);
    expect(out.visible.map((c) => c.id)).toEqual(["a", "c"]);
    expect(out.hiddenCount).toBe(0);
  });

  it("filter is case-insensitive and trims whitespace", () => {
    const chats = [{ id: "a", title: "Important Note" }];
    expect(
      filterAndPaginateChats(chats, "  IMPORTANT  ", false, 30).visible
    ).toHaveLength(1);
  });

  it("filter with no matches returns empty visible, zero hidden", () => {
    const chats = makeChats(50);
    const out = filterAndPaginateChats(chats, "nonexistent", false, 30);
    expect(out.visible).toHaveLength(0);
    expect(out.hiddenCount).toBe(0);
  });

  it("handles chats with undefined title without throwing", () => {
    const chats = [
      { id: "a", title: undefined },
      { id: "b", title: "hello" },
    ];
    const out = filterAndPaginateChats(chats, "hello", false, 30);
    expect(out.visible.map((c) => c.id)).toEqual(["b"]);
  });

  it("exactly at the limit boundary: no hidden tail, no Show-more line", () => {
    const chats = makeChats(30);
    const out = filterAndPaginateChats(chats, "", false, 30);
    expect(out.visible).toHaveLength(30);
    expect(out.hiddenCount).toBe(0);
  });
});
