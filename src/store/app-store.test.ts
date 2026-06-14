/**
 * Tests for the Zustand app store. Pure-state store, no async, no I/O —
 * the actions just transform the in-memory shape. We test the actions
 * against the public `getState`/`setState` surface that Zustand exposes.
 *
 * Pinned invariants (sourced from CLAUDE.md + the chat-panel consumer):
 *   - `removeChat` clears `activeChatId` if it pointed at the removed chat.
 *   - `setActiveProjectId` resets `activeChatId` and `currentPath` —
 *     switching projects must NOT carry over a chat from a different
 *     project (would render messages from the wrong project's data).
 *   - `addChat` prepends — most-recent first — to match the sidebar order.
 *   - `swarmEnabled` defaults to `true`, `daemonMode` to `false`,
 *     `activePreset` to `"custom"` (CLAUDE.md: never auto-override the
 *     user's manually-configured model).
 *
 * Vitest's `useAppStore.setState({...}, true)` (replace=true) resets the
 * store between tests; we use the milder per-test approach of setting
 * just the keys under test back to defaults.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./app-store";
import type { ChatListItem, Project } from "@/lib/types";

const initialState = useAppStore.getState();

beforeEach(() => {
  // Restore pristine state by writing the snapshot we captured at module load.
  // `replace=true` discards any keys we didn't carry over.
  useAppStore.setState(initialState, true);
});

const chat = (id: string, projectId?: string): ChatListItem => ({
  id,
  title: `chat ${id}`,
  projectId,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  messageCount: 0,
});

describe("defaults — protect the user's intent", () => {
  it("swarmEnabled defaults to true (Swarm is the headline feature)", () => {
    expect(useAppStore.getState().swarmEnabled).toBe(true);
  });

  it("daemonMode defaults to false (background mode is opt-in)", () => {
    expect(useAppStore.getState().daemonMode).toBe(false);
  });

  it('activePreset defaults to "custom" (never override user-configured model)', () => {
    expect(useAppStore.getState().activePreset).toBe("custom");
  });

  it("sidebarTab defaults to 'chats'", () => {
    expect(useAppStore.getState().sidebarTab).toBe("chats");
  });

  it("collections start empty", () => {
    const s = useAppStore.getState();
    expect(s.chats).toEqual([]);
    expect(s.projects).toEqual([]);
    expect(s.activeChatId).toBeNull();
    expect(s.activeProjectId).toBeNull();
    expect(s.currentPath).toBe("");
  });
});

describe("chats actions", () => {
  it("setChats replaces the list wholesale", () => {
    useAppStore.getState().setChats([chat("a"), chat("b")]);
    expect(useAppStore.getState().chats).toHaveLength(2);
    // Capture the factory object ONCE. `chat()` stamps `createdAt`/`updatedAt`
    // with `new Date().toISOString()`, so re-invoking it inside
    // `toEqual([chat("c")])` minted a SECOND, fresh timestamp; on a millisecond
    // boundary under parallel load the two differed and flaked the deep-equal.
    const replacement = chat("c");
    useAppStore.getState().setChats([replacement]);
    expect(useAppStore.getState().chats).toEqual([replacement]);
  });

  it("addChat PREPENDS (most-recent first matches sidebar order)", () => {
    useAppStore.getState().setChats([chat("old")]);
    useAppStore.getState().addChat(chat("new"));
    const ids = useAppStore.getState().chats.map((c) => c.id);
    expect(ids).toEqual(["new", "old"]);
  });

  it("removeChat removes the chat", () => {
    useAppStore.getState().setChats([chat("a"), chat("b"), chat("c")]);
    useAppStore.getState().removeChat("b");
    expect(useAppStore.getState().chats.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("removeChat clears activeChatId if it pointed at the removed chat", () => {
    useAppStore.getState().setChats([chat("a"), chat("b")]);
    useAppStore.getState().setActiveChatId("a");
    useAppStore.getState().removeChat("a");
    expect(useAppStore.getState().activeChatId).toBeNull();
  });

  it("removeChat KEEPS activeChatId if a different chat was removed", () => {
    useAppStore.getState().setChats([chat("a"), chat("b")]);
    useAppStore.getState().setActiveChatId("a");
    useAppStore.getState().removeChat("b");
    expect(useAppStore.getState().activeChatId).toBe("a");
  });
});

describe("projects actions — switching project resets dependent state", () => {
  const proj = (id: string): Project => ({
    id,
    name: `project ${id}`,
    createdAt: new Date().toISOString(),
  } as Project);

  it("setActiveProjectId clears activeChatId and currentPath together", () => {
    useAppStore.getState().setProjects([proj("p-1"), proj("p-2")]);
    useAppStore.getState().setActiveChatId("c-from-p1");
    useAppStore.getState().setCurrentPath("src/foo");
    useAppStore.getState().setActiveProjectId("p-2");

    const s = useAppStore.getState();
    expect(s.activeProjectId).toBe("p-2");
    expect(s.activeChatId).toBeNull();
    expect(s.currentPath).toBe("");
  });

  it("setActiveProjectId(null) — going to global — also resets dependents", () => {
    useAppStore.getState().setActiveProjectId("p-1");
    useAppStore.getState().setActiveChatId("c-1");
    useAppStore.getState().setCurrentPath("a/b");
    useAppStore.getState().setActiveProjectId(null);

    const s = useAppStore.getState();
    expect(s.activeProjectId).toBeNull();
    expect(s.activeChatId).toBeNull();
    expect(s.currentPath).toBe("");
  });
});

describe("toggle actions — swarm/daemon/preset", () => {
  it("setSwarmEnabled toggles cleanly without leaking other state", () => {
    useAppStore.getState().setActiveChatId("c-1");
    useAppStore.getState().setSwarmEnabled(false);
    expect(useAppStore.getState().swarmEnabled).toBe(false);
    expect(useAppStore.getState().activeChatId).toBe("c-1"); // unrelated state preserved
  });

  it("setDaemonMode toggles cleanly", () => {
    useAppStore.getState().setDaemonMode(true);
    expect(useAppStore.getState().daemonMode).toBe(true);
    useAppStore.getState().setDaemonMode(false);
    expect(useAppStore.getState().daemonMode).toBe(false);
  });

  it("setActivePreset accepts the legacy 'custom' tier", () => {
    useAppStore.getState().setActivePreset("custom");
    expect(useAppStore.getState().activePreset).toBe("custom");
  });

  it("setSidebarTab accepts both 'chats' and 'projects'", () => {
    useAppStore.getState().setSidebarTab("projects");
    expect(useAppStore.getState().sidebarTab).toBe("projects");
    useAppStore.getState().setSidebarTab("chats");
    expect(useAppStore.getState().sidebarTab).toBe("chats");
  });
});
