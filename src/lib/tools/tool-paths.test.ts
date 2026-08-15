import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  normalizeContextPathForOutput,
  resolveContextBaseDir,
  resolveContextCwd,
  resolveOutgoingFilePath,
  resolveReadableFilePath,
} from "./tool-paths";
import { getProjectMetaRoot } from "@/lib/storage/project-store";
import type { AgentContext } from "@/lib/agent/types";

/**
 * Behavior pins for the context/path helpers extracted from `tool.ts`
 * (§10 decomposition, PR 1). These are the contracts every file/exec/upload
 * tool depends on: the sandbox fallback of `resolveContextCwd`, the
 * candidate order of `resolveReadableFilePath` (incl. the chat-files
 * upload fallback), and absolute-path passthrough.
 */

let tmpRoot: string;
let dataDir: string;
let prevDataDirEnv: string | undefined;

function ctx(over: Partial<AgentContext> = {}): AgentContext {
  return {
    chatId: "chat-1",
    projectId: undefined,
    history: [],
    agentNumber: 0,
    ...over,
  } as AgentContext;
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tool-paths-test-"));
  dataDir = path.join(tmpRoot, "data");
  await fs.mkdir(dataDir, { recursive: true });
  prevDataDirEnv = process.env.ORCHESTRA_DATA_DIR;
  process.env.ORCHESTRA_DATA_DIR = dataDir;
});

afterAll(async () => {
  if (prevDataDirEnv === undefined) delete process.env.ORCHESTRA_DATA_DIR;
  else process.env.ORCHESTRA_DATA_DIR = prevDataDirEnv;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("resolveContextCwd", () => {
  it("prefers a pre-resolved context.workDir", () => {
    const workDir = path.join(os.tmpdir(), "linked-project-root");
    expect(resolveContextCwd(ctx({ workDir }))).toBe(workDir);
  });

  it("resolves currentPath relative to workDir, stripping absolute-like prefixes", () => {
    const workDir = path.join(os.tmpdir(), "wd");
    expect(resolveContextCwd(ctx({ workDir, currentPath: "src/lib" }))).toBe(
      path.join(workDir, "src/lib")
    );
    expect(resolveContextCwd(ctx({ workDir, currentPath: "/src/lib" }))).toBe(
      path.join(workDir, "src/lib")
    );
  });

  it("falls back to the base dir when currentPath escapes it (sandbox posture)", () => {
    const workDir = path.join(os.tmpdir(), "wd");
    expect(resolveContextCwd(ctx({ workDir, currentPath: "../../etc" }))).toBe(
      workDir
    );
  });

  // PM #105 — the fallback is deliberately the Orchestra-owned META root, not
  // a synchronous guess at the content root. A context with no `workDir` has
  // no resolved project; the sandbox is the honest answer, and a linked
  // project's real repo can only be reached through the async resolver.
  it("falls back to the project META root when no workDir is set", () => {
    expect(resolveContextCwd(ctx({ workDir: undefined }))).toBe(
      getProjectMetaRoot(undefined)
    );
  });
});

describe("resolveContextBaseDir", () => {
  it("prefers context.workDir and ignores currentPath", () => {
    const workDir = path.join(os.tmpdir(), "linked-project-root");
    expect(
      resolveContextBaseDir(ctx({ workDir, currentPath: "src/lib" }))
    ).toBe(workDir);
  });

  it("falls back to the project META root when workDir is blank", () => {
    expect(resolveContextBaseDir(ctx({ workDir: "   ", projectId: "p-1" }))).toBe(
      getProjectMetaRoot("p-1")
    );
  });
});

describe("resolveOutgoingFilePath", () => {
  it("throws on an empty path", () => {
    expect(() => resolveOutgoingFilePath(ctx(), "  ")).toThrow(
      "file_path is required"
    );
  });

  it("passes absolute paths through resolved", () => {
    const abs = path.join(os.tmpdir(), "out", "..", "out", "file.txt");
    expect(resolveOutgoingFilePath(ctx(), abs)).toBe(path.resolve(abs));
  });

  it("resolves relative paths against the context cwd", () => {
    const workDir = path.join(os.tmpdir(), "wd");
    expect(resolveOutgoingFilePath(ctx({ workDir }), "notes/a.md")).toBe(
      path.join(workDir, "notes/a.md")
    );
  });
});

describe("resolveReadableFilePath", () => {
  it("returns the cwd-relative candidate when it exists", async () => {
    const workDir = path.join(tmpRoot, "proj");
    await fs.mkdir(workDir, { recursive: true });
    const file = path.join(workDir, "readme.md");
    await fs.writeFile(file, "hi", "utf-8");

    expect(await resolveReadableFilePath(ctx({ workDir }), "readme.md")).toBe(
      file
    );
  });

  it("falls back to data/chat-files/<chatId>/ for a bare filename upload", async () => {
    const chatId = "chat-upload";
    const chatFilesDir = path.join(dataDir, "chat-files", chatId);
    await fs.mkdir(chatFilesDir, { recursive: true });
    const uploaded = path.join(chatFilesDir, "voice.ogg");
    await fs.writeFile(uploaded, "audio", "utf-8");

    const workDir = path.join(tmpRoot, "proj-empty");
    await fs.mkdir(workDir, { recursive: true });

    expect(
      await resolveReadableFilePath(ctx({ workDir, chatId }), "voice.ogg")
    ).toBe(uploaded);
  });

  it("recovers an accidental slashless Unix absolute path", async () => {
    const workDir = path.join(tmpRoot, "proj2");
    await fs.mkdir(workDir, { recursive: true });
    // "tmp/..." (no leading slash) should be tried as "/tmp/..." too.
    const absTarget = path.join(os.tmpdir(), "tool-paths-slashless.txt");
    await fs.writeFile(absTarget, "x", "utf-8");
    const slashless = absTarget.replace(/^\//, "");

    try {
      expect(
        await resolveReadableFilePath(ctx({ workDir }), slashless)
      ).toBe(path.resolve(path.sep, slashless));
    } finally {
      await fs.rm(absTarget, { force: true });
    }
  });

  it("returns the first candidate when nothing exists (caller stats for the precise error)", async () => {
    const workDir = path.join(tmpRoot, "proj3");
    await fs.mkdir(workDir, { recursive: true });
    expect(
      await resolveReadableFilePath(ctx({ workDir }), "missing/nope.txt")
    ).toBe(path.join(workDir, "missing/nope.txt"));
  });
});

describe("normalizeContextPathForOutput", () => {
  it("maps empty, whitespace, and '.' to ''", () => {
    expect(normalizeContextPathForOutput(undefined)).toBe("");
    expect(normalizeContextPathForOutput("  ")).toBe("");
    expect(normalizeContextPathForOutput(".")).toBe("");
  });

  it("strips leading separators and converts backslashes", () => {
    expect(normalizeContextPathForOutput("/src/lib")).toBe("src/lib");
    expect(normalizeContextPathForOutput("src\\lib")).toBe("src/lib");
  });
});
