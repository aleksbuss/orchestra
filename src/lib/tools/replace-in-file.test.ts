import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs/promises";
import { createAgentTools } from "./tool";
import * as postWriteVerify from "@/lib/tools/post-write-verify";
import type { AgentContext } from "@/lib/agent/types";

// Mock dependencies
vi.mock("fs/promises", () => ({
  default: {
    stat: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock("@/lib/storage/snapshots", () => ({
  snapshotBeforeWrite: vi.fn(),
}));

vi.mock("@/lib/tools/post-write-verify", () => ({
  verifyWrittenSource: vi.fn(),
}));

// Provide a mock context
const mockContext: AgentContext = {
  chatId: "test-chat-id",
  projectId: "test-project",
  mode: "main",
  features: {},
} as any;

describe("tools.replace_in_file", () => {
  let replaceInFile: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Provide a mock AppSettings object
    const mockSettings = {
      codeExecution: { enabled: false },
      memory: { enabled: false },
      search: { provider: "none" }
    } as any;

    const tools = createAgentTools(mockContext, mockSettings);
    replaceInFile = tools.replace_in_file;
  });

  it("should do a basic exact replace", async () => {
    vi.mocked(fs.stat).mockResolvedValue({
      isFile: () => true,
      size: 100,
    } as any);
    vi.mocked(fs.readFile).mockResolvedValue("hello world\nthis is a test\n");
    vi.mocked(postWriteVerify.verifyWrittenSource).mockResolvedValue(null as any);

    const result = (await replaceInFile.execute({
      file_path: "/test.txt",
      target_content: "world\nthis",
      replacement_content: "moon\nthat",
    }, {} as any)) as any;

    expect(result.success).toBe(true);
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("test.txt"),
      "hello moon\nthat is a test\n",
      "utf-8"
    );
  });

  it("should handle regex special chars like $& and $1 without corrupting code", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 100 } as any);
    vi.mocked(fs.readFile).mockResolvedValue("const a = 1;");
    vi.mocked(postWriteVerify.verifyWrittenSource).mockResolvedValue(null as any);
    
    const result = (await replaceInFile.execute({
      file_path: "/test.txt",
      target_content: "const a = 1;",
      replacement_content: "const a = 1; // updated $& and $1",
    }, {} as any)) as any;

    expect(result.success).toBe(true);
    // Standard String.prototype.replace would insert "const a = 1;" in place of $&
    // But split().join() should insert the literal string
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("test.txt"),
      "const a = 1; // updated $& and $1",
      "utf-8"
    );
  });

  it("should handle Smart CRLF adaptation", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 100 } as any);
    vi.mocked(fs.readFile).mockResolvedValue("line 1\r\nline 2\r\nline 3");
    vi.mocked(postWriteVerify.verifyWrittenSource).mockResolvedValue(null as any);
    
    const result = (await replaceInFile.execute({
      file_path: "/test.txt",
      target_content: "line 1\nline 2", // LLM generated LF
      replacement_content: "line 1\nnew line\nline 2", // LLM generated LF
    }, {} as any)) as any;

    expect(result.success).toBe(true);
    // Should preserve CRLF in the written file and correctly match the target
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("test.txt"),
      "line 1\r\nnew line\r\nline 2\r\nline 3",
      "utf-8"
    );
  });

  it("should fail if target_content is not found", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);
    vi.mocked(fs.readFile).mockResolvedValue("some content");
    
    const result = (await replaceInFile.execute({
      file_path: "/test.txt",
      target_content: "missing",
      replacement_content: "new",
    }, {} as any)) as any;

    expect(result.success).toBe(false);
    expect(result.error).toContain("Target content not found");
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("should fail if target_content is found multiple times", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);
    vi.mocked(fs.readFile).mockResolvedValue("match\nmatch\n");
    
    const result = (await replaceInFile.execute({
      file_path: "/test.txt",
      target_content: "match",
      replacement_content: "new",
    }, {} as any)) as any;

    expect(result.success).toBe(false);
    expect(result.error).toContain("Target content found 2 times");
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("should fail if newContent is too large", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);
    vi.mocked(fs.readFile).mockResolvedValue("start");
    
    // TEXT_FILE_WRITE_MAX_CHARS is 400000
    const huge = "x".repeat(400001);
    
    const result = (await replaceInFile.execute({
      file_path: "/test.txt",
      target_content: "start",
      replacement_content: huge,
    }, {} as any)) as any;

    expect(result.success).toBe(false);
    expect(result.error).toContain("too large");
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("should fail if target is not a regular file (e.g. a directory)", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => false } as any);
    
    const result = (await replaceInFile.execute({
      file_path: "/test_dir",
      target_content: "start",
      replacement_content: "end",
    }, {} as any)) as any;

    expect(result.success).toBe(false);
    expect(result.error).toContain("Target exists and is not a regular file");
  });

  it("should fail if file does not exist (ENOENT)", async () => {
    const error = new Error("Not found");
    (error as any).code = "ENOENT";
    vi.mocked(fs.stat).mockRejectedValue(error);
    
    const result = (await replaceInFile.execute({
      file_path: "/test.txt",
      target_content: "start",
      replacement_content: "end",
    }, {} as any)) as any;

    expect(result.success).toBe(false);
    expect(result.error).toContain("File does not exist");
  });

  it("should propagate general filesystem errors (e.g. EACCES)", async () => {
    const error = new Error("Permission denied");
    (error as any).code = "EACCES";
    vi.mocked(fs.stat).mockRejectedValue(error);
    
    const result = (await replaceInFile.execute({
      file_path: "/test.txt",
      target_content: "start",
      replacement_content: "end",
    }, {} as any)) as any;

    expect(result.success).toBe(false);
    expect(result.error).toContain("Permission denied");
  });

  it("should report syntax errors if verifyWrittenSource flags the new code", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 100 } as any);
    vi.mocked(fs.readFile).mockResolvedValue("const a = 1;");
    vi.mocked(postWriteVerify.verifyWrittenSource).mockResolvedValue({
      valid: false,
      diagnostics: "Missing semicolon",
      hint: "Add semicolon"
    } as any);

    const result = (await replaceInFile.execute({
      file_path: "/test.txt",
      target_content: "const a = 1;",
      replacement_content: "const a = 1",
    }, {} as any)) as any;

    expect(result.success).toBe(true);
    expect(result.syntaxValid).toBe(false);
    expect(result.syntaxErrors).toBe("Missing semicolon");
    expect(result.warning).toBe("Add semicolon");
  });

  it("should report syntaxValid true if verifyWrittenSource confirms validity", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 100 } as any);
    vi.mocked(fs.readFile).mockResolvedValue("const a = 1;");
    vi.mocked(postWriteVerify.verifyWrittenSource).mockResolvedValue({
      valid: true
    } as any);

    const result = (await replaceInFile.execute({
      file_path: "/test.txt",
      target_content: "const a = 1;",
      replacement_content: "const a = 1;",
    }, {} as any)) as any;

    expect(result.success).toBe(true);
    expect(result.syntaxValid).toBe(true);
  });
});
