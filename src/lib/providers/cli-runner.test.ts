import { describe, it, expect, vi, afterEach } from "vitest";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import {
  collectPromptText,
  parseGeminiOutput,
  resolveCliWorkingDirectory,
  runCliCommand,
} from "./cli-runner";
import { getWorkDir } from "@/lib/storage/project-store";
import path from "path";

vi.mock("@/lib/storage/project-store", () => ({
  getWorkDir: vi.fn(),
  loadProjectMcpServers: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function callOptionsWithPrompt(prompt: unknown): LanguageModelV3CallOptions {
  return { prompt } as LanguageModelV3CallOptions;
}

// ---- collectPromptText -------------------------------------------------------

describe("collectPromptText", () => {
  it("joins text parts across messages with blank lines", () => {
    const options = callOptionsWithPrompt([
      { role: "system", content: [{ type: "text", text: "You are terse." }] },
      { role: "user", content: [{ type: "text", text: "  hello  " }] },
    ]);
    expect(collectPromptText(options)).toBe("You are terse.\n\n  hello");
  });

  it("skips non-text parts, blank texts, and non-array content", () => {
    const options = callOptionsWithPrompt([
      { role: "user", content: "raw string content" },
      {
        role: "user",
        content: [
          { type: "file", data: "…" },
          { type: "text", text: "   " },
          { type: "text", text: "kept" },
        ],
      },
    ]);
    expect(collectPromptText(options)).toBe("kept");
  });

  it("returns the empty string for an empty prompt", () => {
    expect(collectPromptText(callOptionsWithPrompt([]))).toBe("");
  });
});

// ---- parseGeminiOutput ---------------------------------------------------------

describe("parseGeminiOutput", () => {
  it("concatenates assistant message chunks", () => {
    const stdout = [
      JSON.stringify({ type: "message", role: "assistant", content: "Hel" }),
      JSON.stringify({ type: "message", role: "user", content: "ignored" }),
      JSON.stringify({ type: "message", role: "assistant", content: "lo" }),
    ].join("\n");
    expect(parseGeminiOutput(stdout, "")).toBe("Hello");
  });

  it("returns the explicit error when no assistant text arrived", () => {
    const stdout = JSON.stringify({ type: "error", message: "quota exceeded" });
    expect(parseGeminiOutput(stdout, "noise")).toBe("quota exceeded");
  });

  it("falls back to the error field when message is absent", () => {
    const stdout = JSON.stringify({ type: "error", error: "boom" });
    expect(parseGeminiOutput(stdout, "")).toBe("boom");
  });

  it("ignores non-JSON lines and falls back to raw stdout+stderr", () => {
    expect(parseGeminiOutput("plain", "warn")).toBe("plain\nwarn");
  });

  it("returns the placeholder when everything is empty", () => {
    expect(parseGeminiOutput("", "")).toBe("Gemini CLI returned no output.");
  });
});

// ---- resolveCliWorkingDirectory --------------------------------------------------

describe("resolveCliWorkingDirectory", () => {
  it("returns process.cwd() without a projectId", () => {
    expect(resolveCliWorkingDirectory(undefined)).toBe(process.cwd());
    expect(resolveCliWorkingDirectory({})).toBe(process.cwd());
  });

  it("returns the project root when currentPath is blank", () => {
    vi.mocked(getWorkDir).mockReturnValue("/tmp/orchestra-projects/p1");
    expect(resolveCliWorkingDirectory({ projectId: "p1", currentPath: "  " })).toBe(
      path.resolve("/tmp/orchestra-projects/p1")
    );
  });

  it("resolves a relative currentPath inside the root", () => {
    vi.mocked(getWorkDir).mockReturnValue("/tmp/orchestra-projects/p1");
    expect(resolveCliWorkingDirectory({ projectId: "p1", currentPath: "src/lib" })).toBe(
      path.resolve("/tmp/orchestra-projects/p1/src/lib")
    );
  });

  it("clamps a traversal attempt back to the root", () => {
    vi.mocked(getWorkDir).mockReturnValue("/tmp/orchestra-projects/p1");
    expect(resolveCliWorkingDirectory({ projectId: "p1", currentPath: "../../etc" })).toBe(
      path.resolve("/tmp/orchestra-projects/p1")
    );
  });

  it("rejects a sibling-prefix escape (p1-evil does not start with p1 + sep)", () => {
    vi.mocked(getWorkDir).mockReturnValue("/tmp/orchestra-projects/p1");
    expect(
      resolveCliWorkingDirectory({ projectId: "p1", currentPath: "../p1-evil" })
    ).toBe(path.resolve("/tmp/orchestra-projects/p1"));
  });
});

// ---- runCliCommand (real spawn of the node binary — hermetic) ---------------------

describe("runCliCommand", () => {
  it("captures stdout and a zero exit code", async () => {
    const result = await runCliCommand(process.execPath, ["-e", 'console.log("hi")']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hi");
    expect(result.timedOut).toBe(false);
  });

  it("reports a non-zero exit code and stderr", async () => {
    const result = await runCliCommand(process.execPath, [
      "-e",
      'console.error("bad"); process.exit(3)',
    ]);
    expect(result.code).toBe(3);
    expect(result.stderr.trim()).toBe("bad");
  });

  it("pipes stdinText into the child", async () => {
    const result = await runCliCommand(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      { stdinText: "echoed" }
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("echoed");
  });

  it("resolves with code 1 and the error message when the binary does not exist", async () => {
    const result = await runCliCommand("definitely-not-a-real-binary-xyz", []);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/ENOENT|not found/i);
  });

  it("kills the child and flags timedOut past timeoutMs", async () => {
    const result = await runCliCommand(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      { timeoutMs: 300 }
    );
    expect(result.timedOut).toBe(true);
  }, 10000);
});
