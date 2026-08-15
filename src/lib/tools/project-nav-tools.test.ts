import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentContext } from "@/lib/agent/types";
import { resolveContextBaseDir, resolveContextCwd } from "@/lib/tools/tool-paths";

/**
 * PM #105 — `get_current_project` is the agent's FIRST orientation step, and
 * for a linked project ("Open Folder", `absoluteRoot`) it used to report the
 * sandbox path `data/projects/<id>/` while every other tool ran in the linked
 * repo. A live run showed the agent obeying the tool: it `cd`-ed into the empty
 * sandbox directory, found no source, and answered from a DIFFERENT repository.
 *
 * The storage layer is mocked so this pins the reporting contract only — no
 * data dir is touched (PM #100).
 */
const getProjectMock = vi.fn();
const getProjectMetaRootMock = vi.fn();

vi.mock("@/lib/storage/project-store", () => ({
  getAllProjects: vi.fn(async () => []),
  createProject: vi.fn(),
  getProject: (...args: unknown[]) => getProjectMock(...args),
  getProjectMetaRoot: (...args: unknown[]) => getProjectMetaRootMock(...args),
}));

const SANDBOX_DIR = "/repo/data/projects/linked-proj";
const LINKED_ROOT = "/Users/dev/real-repo";
const GLOBAL_DIR = "/repo/data/projects";

function ctx(over: Partial<AgentContext> = {}): AgentContext {
  return {
    chatId: "chat-1",
    projectId: "linked-proj",
    history: [],
    agentNumber: 0,
    ...over,
  } as AgentContext;
}

async function currentProject(context: AgentContext) {
  const { createProjectNavTools } = await import("./project-nav-tools");
  const tools = createProjectNavTools(context);
  const execute = tools.get_current_project?.execute;
  if (!execute) throw new Error("get_current_project is not registered");
  return (await execute({}, {
    toolCallId: "t1",
    messages: [],
  })) as { workDir: string; projectId: string | null; isGlobal: boolean };
}

beforeEach(() => {
  getProjectMock.mockReset();
  getProjectMetaRootMock.mockReset();
  getProjectMock.mockResolvedValue({ id: "linked-proj", name: "Linked" });
  getProjectMetaRootMock.mockReturnValue(SANDBOX_DIR);
});

describe("get_current_project workDir reporting", () => {
  it("reports the linked repo root, not the sandbox dir, when context.workDir is resolved", async () => {
    const result = await currentProject(ctx({ workDir: LINKED_ROOT }));
    expect(result.workDir).toBe(LINKED_ROOT);
    expect(result.workDir).not.toBe(SANDBOX_DIR);
  });

  it("falls back to the project META root for sandbox projects with no resolved workDir", async () => {
    const result = await currentProject(ctx({ workDir: undefined }));
    expect(result.workDir).toBe(SANDBOX_DIR);
    expect(getProjectMetaRootMock).toHaveBeenCalledWith("linked-proj");
  });

  it("ignores a blank workDir rather than reporting an empty path", async () => {
    const result = await currentProject(ctx({ workDir: "   " }));
    expect(result.workDir).toBe(SANDBOX_DIR);
  });

  // The actual PM #105 defect was not a wrong constant — it was TWO resolvers.
  // Pin that the reported path is byte-identical to the one the acting tools
  // compute, in both the linked and the sandbox case.
  it("reports exactly what resolveContextCwd would use as its base", async () => {
    for (const workDir of [LINKED_ROOT, undefined, "   "]) {
      const context = ctx({ workDir });
      const result = await currentProject(context);
      expect(result.workDir).toBe(resolveContextBaseDir(context));
      expect(result.workDir).toBe(resolveContextCwd(context));
    }
  });

  it("reports the GLOBAL sandbox root, not a bare undefined, with no project", async () => {
    getProjectMetaRootMock.mockReturnValue(GLOBAL_DIR);
    const result = await currentProject(
      ctx({ projectId: undefined, workDir: undefined })
    );
    expect(result.isGlobal).toBe(true);
    expect(result.workDir).toBe(GLOBAL_DIR);
  });
});
