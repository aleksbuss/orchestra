/**
 * Tests for `handleExternalMessage` — the integration core behind
 * POST /api/external/message and the Telegram webhook bridge.
 *
 * The function is 350+ lines of orchestration: resolve project, resolve
 * chat, run agent, parse switch_project / create_project signals from
 * the resulting tool messages, and persist session state. Each section
 * has its own failure mode; we cover them as separate `describe` blocks.
 *
 * Storage layer is mocked via `vi.mock` — uses the same approach as
 * `daemon.test.ts` and the route tests we wrote earlier.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChatMessage, Chat } from "@/lib/types";

// ────────────────────────────────────────────────────────────
// Module mocks
// ────────────────────────────────────────────────────────────

vi.mock("@/lib/agent/agent", () => ({
  runAgentText: vi.fn(),
}));

vi.mock("@/lib/storage/chat-store", () => ({
  createChat: vi.fn(),
  getChat: vi.fn(),
}));

vi.mock("@/lib/storage/project-store", () => ({
  getAllProjects: vi.fn(),
  getProject: vi.fn(),
}));

vi.mock("@/lib/storage/external-session-store", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/storage/external-session-store")
  >("@/lib/storage/external-session-store");
  return {
    ...actual,
    getOrCreateExternalSession: vi.fn(),
    saveExternalSession: vi.fn(),
  };
});

import {
  ExternalMessageError,
  handleExternalMessage,
} from "./handle-external-message";
import { runAgentText } from "@/lib/agent/agent";
import { createChat, getChat } from "@/lib/storage/chat-store";
import { getAllProjects, getProject } from "@/lib/storage/project-store";
import {
  getOrCreateExternalSession,
  saveExternalSession,
  type ExternalSession,
} from "@/lib/storage/external-session-store";

// ────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────

const newSession = (): ExternalSession => ({
  id: "tg:42",
  activeProjectId: null,
  activeChats: {},
  currentPaths: {},
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
});

const fakeProject = (id: string, name = `Project ${id}`) =>
  ({ id, name } as never);

const fakeChat = (id: string, projectId?: string, messages: ChatMessage[] = []): Chat =>
  ({
    id,
    title: `chat ${id}`,
    projectId,
    messages,
    createdAt: "x",
    updatedAt: "x",
  } as Chat);

beforeEach(() => {
  vi.clearAllMocks();

  // Default: known sessions / chats / projects come back with sane shapes.
  vi.mocked(getOrCreateExternalSession).mockImplementation(async () => newSession());
  vi.mocked(saveExternalSession).mockResolvedValue(undefined);
  vi.mocked(getAllProjects).mockResolvedValue([]);
  vi.mocked(getProject).mockResolvedValue(null);
  vi.mocked(getChat).mockResolvedValue(null);
  vi.mocked(createChat).mockResolvedValue(undefined as never);
  vi.mocked(runAgentText).mockResolvedValue("default reply");
});

// ────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────

describe("handleExternalMessage — input validation", () => {
  it("throws ExternalMessageError(400) when sessionId is empty/whitespace", async () => {
    await expect(
      handleExternalMessage({ sessionId: "", message: "x" })
    ).rejects.toMatchObject({
      status: 400,
      payload: { error: "sessionId is required" },
    });

    await expect(
      handleExternalMessage({ sessionId: "   ", message: "x" })
    ).rejects.toBeInstanceOf(ExternalMessageError);
  });

  it("throws ExternalMessageError(400) when message is empty/whitespace", async () => {
    await expect(
      handleExternalMessage({ sessionId: "s", message: "" })
    ).rejects.toMatchObject({
      status: 400,
      payload: { error: "message is required" },
    });
  });
});

// ────────────────────────────────────────────────────────────
// Project resolution
// ────────────────────────────────────────────────────────────

describe("handleExternalMessage — project resolution", () => {
  it("uses an explicitly-provided projectId when it exists", async () => {
    vi.mocked(getAllProjects).mockResolvedValue([
      fakeProject("p-1"),
      fakeProject("p-2"),
    ]);

    await handleExternalMessage({
      sessionId: "s",
      message: "hi",
      projectId: "p-2",
    });

    expect(runAgentText).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-2" })
    );
  });

  it("throws ExternalMessageError(404) with availableProjects when explicit projectId is unknown", async () => {
    vi.mocked(getAllProjects).mockResolvedValue([
      fakeProject("p-real-1"),
      fakeProject("p-real-2"),
    ]);

    await expect(
      handleExternalMessage({
        sessionId: "s",
        message: "hi",
        projectId: "missing",
      })
    ).rejects.toMatchObject({
      status: 404,
      payload: {
        error: 'Project "missing" not found',
        availableProjects: [
          { id: "p-real-1", name: "Project p-real-1" },
          { id: "p-real-2", name: "Project p-real-2" },
        ],
      },
    });
  });

  it("falls back to session.activeProjectId when no explicit projectId is given", async () => {
    vi.mocked(getAllProjects).mockResolvedValue([
      fakeProject("p-stored"),
    ]);
    vi.mocked(getOrCreateExternalSession).mockImplementation(async () => ({
      ...newSession(),
      activeProjectId: "p-stored",
    }));

    await handleExternalMessage({ sessionId: "s", message: "hi" });
    expect(runAgentText).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-stored" })
    );
  });

  it("falls back to FIRST project when no explicit AND session has no active", async () => {
    vi.mocked(getAllProjects).mockResolvedValue([
      fakeProject("p-first"),
      fakeProject("p-second"),
    ]);

    await handleExternalMessage({ sessionId: "s", message: "hi" });
    expect(runAgentText).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-first" })
    );
  });

  it("clears stale session.activeProjectId if project no longer exists", async () => {
    vi.mocked(getAllProjects).mockResolvedValue([fakeProject("p-real")]);
    const stale: ExternalSession = {
      ...newSession(),
      activeProjectId: "p-deleted",
    };
    vi.mocked(getOrCreateExternalSession).mockResolvedValue(stale);

    await handleExternalMessage({ sessionId: "s", message: "hi" });

    // The session resolves to the first project (since the stale one is
    // gone), and saveExternalSession is called with the cleaned-up ref.
    expect(saveExternalSession).toHaveBeenCalled();
    const saved = vi.mocked(saveExternalSession).mock.calls[0][0];
    expect(saved.activeProjectId).toBe("p-real"); // updated to the fallback
  });

  it("agrees with no project when there are zero projects in the system", async () => {
    vi.mocked(getAllProjects).mockResolvedValue([]);

    await handleExternalMessage({ sessionId: "s", message: "hi" });
    expect(runAgentText).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: undefined })
    );
  });
});

// ────────────────────────────────────────────────────────────
// Chat resolution
// ────────────────────────────────────────────────────────────

describe("handleExternalMessage — chat resolution", () => {
  it("uses explicit chatId when it exists and matches the project", async () => {
    vi.mocked(getAllProjects).mockResolvedValue([fakeProject("p-1")]);
    vi.mocked(getChat).mockImplementation(async (id: string) =>
      id === "c-explicit" ? fakeChat("c-explicit", "p-1") : null
    );

    await handleExternalMessage({
      sessionId: "s",
      message: "x",
      projectId: "p-1",
      chatId: "c-explicit",
    });

    expect(runAgentText).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "c-explicit" })
    );
    expect(createChat).not.toHaveBeenCalled();
  });

  it("throws 404 when explicit chatId does not exist", async () => {
    vi.mocked(getAllProjects).mockResolvedValue([fakeProject("p-1")]);
    vi.mocked(getChat).mockResolvedValue(null);

    await expect(
      handleExternalMessage({
        sessionId: "s",
        message: "x",
        projectId: "p-1",
        chatId: "c-missing",
      })
    ).rejects.toMatchObject({
      status: 404,
      payload: { error: 'Chat "c-missing" not found' },
    });
  });

  it("throws 409 when explicit chatId belongs to a DIFFERENT project (cross-project leak guard)", async () => {
    vi.mocked(getAllProjects).mockResolvedValue([
      fakeProject("p-1"),
      fakeProject("p-2"),
    ]);
    vi.mocked(getChat).mockResolvedValue(fakeChat("c-from-p2", "p-2"));

    await expect(
      handleExternalMessage({
        sessionId: "s",
        message: "x",
        projectId: "p-1",
        chatId: "c-from-p2",
      })
    ).rejects.toMatchObject({
      status: 409,
      payload: { error: expect.stringMatching(/different project/i) },
    });
  });

  it("creates a new chat when session has none for the active project", async () => {
    vi.mocked(getAllProjects).mockResolvedValue([fakeProject("p-1")]);
    vi.mocked(getOrCreateExternalSession).mockImplementation(async () => ({
      ...newSession(),
      activeProjectId: "p-1",
    }));

    await handleExternalMessage({ sessionId: "s", message: "x" });

    // createChat called with a fresh UUID, the title format, and the project id.
    expect(createChat).toHaveBeenCalledOnce();
    const [chatId, title, projectId] = vi.mocked(createChat).mock.calls[0];
    expect(typeof chatId).toBe("string");
    expect(chatId.length).toBeGreaterThan(8);
    expect(title).toMatch(/External session tg:42/);
    expect(projectId).toBe("p-1");
  });

  it("reuses the session's stored chat when it matches the project", async () => {
    vi.mocked(getAllProjects).mockResolvedValue([fakeProject("p-1")]);
    vi.mocked(getChat).mockImplementation(async (id: string) =>
      id === "c-stored" ? fakeChat("c-stored", "p-1") : null
    );
    vi.mocked(getOrCreateExternalSession).mockImplementation(async () => ({
      ...newSession(),
      activeProjectId: "p-1",
      activeChats: { "p-1": "c-stored" },
    }));

    await handleExternalMessage({ sessionId: "s", message: "x" });

    expect(runAgentText).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "c-stored" })
    );
    expect(createChat).not.toHaveBeenCalled();
  });

  it("creates a NEW chat when stored chat has drifted to a different project", async () => {
    vi.mocked(getAllProjects).mockResolvedValue([
      fakeProject("p-1"),
      fakeProject("p-2"),
    ]);
    // Stored chat says it's in p-2, but the session's active project is p-1.
    // Stale binding → create a fresh chat, don't leak across projects.
    vi.mocked(getChat).mockImplementation(async (id: string) =>
      id === "c-stale" ? fakeChat("c-stale", "p-2") : null
    );
    vi.mocked(getOrCreateExternalSession).mockImplementation(async () => ({
      ...newSession(),
      activeProjectId: "p-1",
      activeChats: { "p-1": "c-stale" },
    }));

    await handleExternalMessage({ sessionId: "s", message: "x" });
    expect(createChat).toHaveBeenCalledOnce();
  });
});

// ────────────────────────────────────────────────────────────
// Tool-result signal parsing (switch / create project)
// ────────────────────────────────────────────────────────────

describe("handleExternalMessage — tool signal parsing", () => {
  function setupAgentReply(
    afterMessages: ChatMessage[],
    projects = [fakeProject("p-1")]
  ) {
    vi.mocked(getAllProjects).mockResolvedValue(projects);
    vi.mocked(getOrCreateExternalSession).mockImplementation(async () => ({
      ...newSession(),
      activeProjectId: "p-1",
      activeChats: { "p-1": "c-1" },
    }));

    let chatState = fakeChat("c-1", "p-1", []);
    vi.mocked(getChat).mockImplementation(async (id: string) =>
      id === "c-1" ? { ...chatState, messages: [...chatState.messages] } : null
    );

    vi.mocked(runAgentText).mockImplementation(async () => {
      // Simulate the agent appending tool-result messages to the chat.
      chatState = { ...chatState, messages: [...chatState.messages, ...afterMessages] };
      return "agent reply";
    });
  }

  it("recognizes a switch_project tool result and reports it in the response", async () => {
    setupAgentReply(
      [
        {
          id: "m1",
          role: "tool",
          toolName: "switch_project",
          toolCallId: "t1",
          content: "",
          toolResult: {
            success: true,
            action: "switch_project",
            projectId: "p-2",
            currentPath: "src/foo",
          },
          createdAt: "x",
        } as ChatMessage,
      ],
      [fakeProject("p-1"), fakeProject("p-2")]
    );

    const result = await handleExternalMessage({ sessionId: "s", message: "switch please" });

    expect(result.switchedProject).toEqual({
      toProjectId: "p-2",
      toProjectName: "Project p-2",
    });
    expect(result.context.activeProjectId).toBe("p-2");
    expect(result.context.currentPath).toBe("src/foo");
  });

  it("recognizes a create_project tool result", async () => {
    setupAgentReply(
      [
        {
          id: "m1",
          role: "tool",
          toolName: "create_project",
          toolCallId: "t1",
          content: "",
          toolResult: {
            success: true,
            action: "create_project",
            projectId: "p-new",
          },
          createdAt: "x",
        } as ChatMessage,
      ],
      [fakeProject("p-1"), fakeProject("p-new", "Brand New")]
    );

    const result = await handleExternalMessage({ sessionId: "s", message: "create one" });
    expect(result.createdProject).toEqual({ id: "p-new", name: "Brand New" });
    expect(result.context.activeProjectId).toBe("p-new");
  });

  it("ignores switch_project signals targeting a project that no longer exists", async () => {
    setupAgentReply([
      {
        id: "m1",
        role: "tool",
        toolName: "switch_project",
        toolCallId: "t1",
        content: "",
        toolResult: {
          success: true,
          action: "switch_project",
          projectId: "p-deleted",
        },
        createdAt: "x",
      } as ChatMessage,
    ]);

    const result = await handleExternalMessage({ sessionId: "s", message: "x" });
    // Switch ignored — context stays with the original active project.
    expect(result.switchedProject).toBeNull();
    expect(result.context.activeProjectId).toBe("p-1");
  });

  it("ignores tool results with success !== true (defensive)", async () => {
    setupAgentReply([
      {
        id: "m1",
        role: "tool",
        toolName: "switch_project",
        toolCallId: "t1",
        content: "",
        toolResult: { success: false, action: "switch_project", projectId: "p-1" },
        createdAt: "x",
      } as ChatMessage,
    ]);

    const result = await handleExternalMessage({ sessionId: "s", message: "x" });
    expect(result.switchedProject).toBeNull();
  });

  it("parses signals carried as a JSON STRING in `content` (Telegram path encodes them so)", async () => {
    setupAgentReply(
      [
        {
          id: "m1",
          role: "tool",
          toolName: "switch_project",
          toolCallId: "t1",
          content: JSON.stringify({
            success: true,
            action: "switch_project",
            projectId: "p-2",
            currentPath: "",
          }),
          createdAt: "x",
        } as ChatMessage,
      ],
      [fakeProject("p-1"), fakeProject("p-2")]
    );

    const result = await handleExternalMessage({ sessionId: "s", message: "x" });
    expect(result.switchedProject?.toProjectId).toBe("p-2");
  });

  it("does not crash on malformed JSON-shaped `content`", async () => {
    setupAgentReply([
      {
        id: "m1",
        role: "tool",
        toolName: "switch_project",
        toolCallId: "t1",
        content: "{ broken JSON",
        createdAt: "x",
      } as ChatMessage,
    ]);

    const result = await handleExternalMessage({ sessionId: "s", message: "x" });
    expect(result.switchedProject).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// Session persistence
// ────────────────────────────────────────────────────────────

describe("handleExternalMessage — session persistence", () => {
  it("calls saveExternalSession exactly once with updated activeChats and updatedAt", async () => {
    vi.mocked(getAllProjects).mockResolvedValue([fakeProject("p-1")]);
    vi.mocked(getOrCreateExternalSession).mockImplementation(async () => ({
      ...newSession(),
      activeProjectId: "p-1",
    }));

    await handleExternalMessage({ sessionId: "s", message: "x" });

    expect(saveExternalSession).toHaveBeenCalledOnce();
    const saved = vi.mocked(saveExternalSession).mock.calls[0][0];
    expect(saved.activeProjectId).toBe("p-1");
    expect(typeof saved.activeChats["p-1"]).toBe("string"); // chat got registered
    expect(new Date(saved.updatedAt).toISOString()).toBe(saved.updatedAt);
  });
});
