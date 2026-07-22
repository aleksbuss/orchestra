import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyGlobalToolLoopGuard } from "./tool-guard";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";

vi.mock("@/lib/realtime/event-bus", () => ({
  publishUiSyncEvent: vi.fn(),
}));
const publishMock = vi.mocked(publishUiSyncEvent);
beforeEach(() => publishMock.mockClear());

// Minimal tool shape — the guard only touches `execute`.
type AnyTool = { execute: (input: unknown, opts: unknown) => Promise<unknown> | unknown };
function wrap(tools: Record<string, AnyTool>) {
  return applyGlobalToolLoopGuard(tools as never) as unknown as Record<string, AnyTool>;
}
const run = (t: AnyTool, input: unknown) => t.execute(input, {} as never);

describe("applyGlobalToolLoopGuard — §4 contract (real extracted guard)", () => {
  it("catches a throwing tool and returns a self-heal string instead of throwing", async () => {
    const tools = wrap({ boom: { execute: () => { throw new Error("kaboom"); } } });
    const out = await run(tools.boom, { x: 1 });
    expect(typeof out).toBe("string");
    expect(out).toContain("[Tool Execution Failed]");
    expect(out).toContain("kaboom");
    expect(out).toContain("Self-Healing");
  });

  it("caps an oversized string tool result (A3 output cap lives in the guard)", async () => {
    const huge = "HEAD" + "x".repeat(50000) + "TAIL";
    const tools = wrap({ big: { execute: () => huge } });
    const out = (await run(tools.big, {})) as string;
    expect(out.length).toBeLessThan(huge.length);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toContain("Orchestra truncated this tool result");
  });

  it("passes the `response` tool through unwrapped", () => {
    const responseExec = () => "final";
    const tools = wrap({ response: { execute: responseExec } });
    expect(tools.response.execute).toBe(responseExec);
  });

  it("blocks a repeated identical deterministic failure on the second call", async () => {
    const tools = wrap({ flaky: { execute: () => ({ success: false, error: "bad arg" }) } });
    const first = (await run(tools.flaky, { a: 1 })) as { success: boolean };
    expect(first.success).toBe(false); // first call passes through
    const second = await run(tools.flaky, { a: 1 }); // identical args + same failure
    expect(typeof second).toBe("string");
    expect(second).toContain("[Loop guard]");
    expect(second).toContain("Blocked repeated");
  });
});

describe("applyGlobalToolLoopGuard — Sprint 1: universal repeat guard (success-leg + A-B-A-B loops)", () => {
  it("blocks identical SUCCESS spam on the 3rd call (the leg the failure-guard missed)", async () => {
    let writes = 0;
    const tools = wrap({
      write_text_file: { execute: () => { writes++; return { success: true, path: "/x" }; } },
    });
    const a = (await run(tools.write_text_file, { path: "/x", content: "junk" })) as { success: boolean };
    const b = (await run(tools.write_text_file, { path: "/x", content: "junk" })) as { success: boolean };
    expect(a.success).toBe(true); // 1st executes
    expect(b.success).toBe(true); // 2nd still executes (one retry tolerated)
    const c = await run(tools.write_text_file, { path: "/x", content: "junk" }); // 3rd identical
    expect(typeof c).toBe("string");
    expect(c).toContain("[Loop guard] CRITICAL");
    expect(c).toContain("NOT executed");
    expect(writes).toBe(2); // the 3rd call did NOT reach the tool
  });

  it("blocks an A→B→A→B loop even though every leg 'succeeds' (alternating identical calls)", async () => {
    let writes = 0;
    let execs = 0;
    const tools = wrap({
      write_text_file: { execute: () => { writes++; return { success: true }; } },
      code_execution: { execute: () => { execs++; return { success: true, output: "ran" }; } },
    });
    await run(tools.write_text_file, { path: "/a", content: "x" }); // A1
    await run(tools.code_execution, { code: "go" });                 // B1
    await run(tools.write_text_file, { path: "/a", content: "x" }); // A2
    await run(tools.code_execution, { code: "go" });                 // B2
    const a3 = await run(tools.write_text_file, { path: "/a", content: "x" }); // A3 → 3rd identical
    expect(typeof a3).toBe("string");
    expect(a3).toContain("[Loop guard] CRITICAL");
    expect(writes).toBe(2); // A3 blocked; both successful execs still ran
    expect(execs).toBe(2);
  });

  it("does NOT block a legitimate fix-loop where the arguments change each pass", async () => {
    let writes = 0;
    const tools = wrap({
      write_text_file: { execute: () => { writes++; return { success: true }; } },
    });
    await run(tools.write_text_file, { path: "/a", content: "v1" });
    await run(tools.write_text_file, { path: "/a", content: "v2" });
    await run(tools.write_text_file, { path: "/a", content: "v3" });
    await run(tools.write_text_file, { path: "/a", content: "v4" });
    expect(writes).toBe(4); // distinct args each pass → never flagged as a loop
  });

  it("exempts poll-like process calls (they own the no-progress backoff, threshold 16)", async () => {
    let polls = 0;
    const tools = wrap({
      process: { execute: () => { polls++; return { output: "still running" }; } },
    });
    for (let i = 0; i < 5; i++) {
      const out = await run(tools.process, { action: "poll", id: "job1" });
      expect(typeof out).toBe("object"); // executed, not blocked by the 3-repeat guard
    }
    expect(polls).toBe(5);
  });
});

describe("deterministic-failure detection — string-JSON and explicit markers", () => {
  // A tool that echoes back whatever output the test injects; identical input
  // twice → the SECOND call is blocked IFF the first output was classified as
  // a deterministic failure. That makes the classifier observable through the
  // public wrapper without exporting internals.
  const blockedOnSecond = async (output: unknown): Promise<unknown> => {
    let calls = 0;
    const tools = wrap({ probe: { execute: () => { calls++; return output; } } });
    await run(tools.probe, { fixed: true });
    const second = await run(tools.probe, { fixed: true });
    return { second, executedBoth: calls === 2 };
  };

  it("classifies a STRING-serialized {success:false} JSON as a failure (parseJsonObject path)", async () => {
    const { second } = (await blockedOnSecond('{"success": false, "error": "boom"}')) as {
      second: unknown;
    };
    expect(String(second)).toContain("[Loop guard]");
    expect(String(second)).toContain("boom");
  });

  it("trims surrounding whitespace before parsing the JSON failure", async () => {
    const { second } = (await blockedOnSecond('   {"success": false, "error": "padded"}  \n')) as {
      second: unknown;
    };
    expect(String(second)).toContain("padded");
  });

  it("does NOT classify a JSON array, an unterminated brace, or garbage as failures", async () => {
    for (const benign of ['[1,2]', '{"success": false', "garbage", '{"success": true}']) {
      const { executedBoth } = (await blockedOnSecond(benign)) as { executedBoth: boolean };
      expect(executedBoth, `benign output executed twice: ${benign}`).toBe(true);
    }
  });

  it("joins error and code into the failure signature ('E | C')", async () => {
    const { second } = (await blockedOnSecond({ success: false, error: "E_TEXT", code: "C_CODE" })) as {
      second: unknown;
    };
    expect(String(second)).toContain("E_TEXT | C_CODE");
  });

  it("falls back to a canned signature when success:false carries no error string", async () => {
    const { second } = (await blockedOnSecond({ success: false })) as { second: unknown };
    expect(String(second)).toContain("Tool returned success=false");
  });

  it("classifies every explicit failure marker string", async () => {
    const failures = [
      "[MCP tool error] upstream died",
      "[Preflight error] bad payload",
      "Process error: spawn ENOENT",
      "something\n[Process killed after timeout]",
      "STDOUT:\nok\n\nExit code: 2",
      "Failed to resolve the target",
      'Skill "deploy" not found.',
      "rg: not found",
    ];
    for (const f of failures) {
      const { second } = (await blockedOnSecond(f)) as { second: unknown };
      expect(String(second), `marker classified as failure: ${f}`).toContain("[Loop guard]");
    }
  });

  it("does NOT classify the memory-miss phrasing as a failure", async () => {
    const { executedBoth } = (await blockedOnSecond("No relevant memories found.")) as {
      executedBoth: boolean;
    };
    expect(executedBoth).toBe(true);
  });
});

describe("auto-recovery hints — code_execution/process outputs", () => {
  const hintFor = async (toolName: string, output: unknown): Promise<unknown> => {
    const tools = wrap({ [toolName]: { execute: () => output } });
    return run(tools[toolName], { probe: 1 });
  };

  it("interactive npx prompt → rerun with `npx -y`", async () => {
    const out = await hintFor(
      "code_execution",
      "Need to install the following packages:\ncowsay\nOk to proceed? (y)"
    );
    expect(String(out)).toContain("[Auto-recovery hint]");
    expect(String(out)).toContain("npx -y");
  });

  it("deprecated playwright-cli npm package → @playwright/cli", async () => {
    const out = await hintFor(
      "code_execution",
      "npm error could not determine executable to run\nwhile running playwright-cli"
    );
    expect(String(out)).toContain("@playwright/cli");
  });

  it("missing Playwright system deps → install-deps directive", async () => {
    const out = await hintFor(
      "code_execution",
      "Host system is missing dependencies to run browsers"
    );
    expect(String(out)).toContain("install-deps");
  });

  it("missing Node module (record output) → install_packages kind=node + recoverable flag", async () => {
    const out = (await hintFor("code_execution", {
      success: false,
      output: "Error: Cannot find module 'lodash'",
    })) as Record<string, unknown>;
    expect(out.recoverable).toBe(true);
    expect(String(out.recoveryHint)).toContain('kind="node"');
    expect(String(out.recoveryHint)).toContain("lodash");
    expect(String(out.output)).toContain("[Auto-recovery hint]");
  });

  it("missing Python module → install_packages kind=python", async () => {
    const out = await hintFor(
      "process",
      "ModuleNotFoundError: No module named 'requests'"
    );
    expect(String(out)).toContain('kind="python"');
    expect(String(out)).toContain("requests");
  });

  it("playwright-cli: not found → npx path first", async () => {
    const out = await hintFor("code_execution", "sh: playwright-cli: not found");
    expect(String(out)).toContain("npx -y @playwright/cli");
  });

  it("generic missing command → install_packages; spawn ENOENT extracts the binary name", async () => {
    const viaShell = await hintFor("code_execution", "rg: not found");
    expect(String(viaShell)).toContain('"rg" is missing');
    const viaSpawn = await hintFor("code_execution", "Error: spawn /usr/local/bin/htop ENOENT");
    expect(String(viaSpawn)).toContain('"htop" is missing');
  });

  it("'node: not found' and 'python3: not found' are NOT hinted (runtime binaries, not packages)", async () => {
    for (const text of ["node: not found", "python3: not found"]) {
      const out = await hintFor("code_execution", text);
      expect(String(out)).not.toContain("[Auto-recovery hint]");
    }
  });

  it("the same text on a NON-exec tool gets no hint", async () => {
    const out = await hintFor("search_web", "Cannot find module 'lodash'");
    expect(String(out)).not.toContain("[Auto-recovery hint]");
  });
});

describe("poll no-progress backoff (threshold 16)", () => {
  it("blocks the 17th identical poll result with a backoff directive", async () => {
    let polls = 0;
    const tools = wrap({
      process: { execute: () => { polls++; return { output: "no change" }; } },
    });
    for (let i = 0; i < 16; i++) {
      await run(tools.process, { action: "poll", id: "stuck" });
    }
    expect(polls).toBe(16);
    const blocked = await run(tools.process, { action: "poll", id: "stuck" });
    expect(String(blocked)).toContain("no-progress polling loop");
    expect(String(blocked)).toContain("~5000ms");
    expect(polls).toBe(16); // 17th never reached the tool
  });

  it("a CHANGED poll result resets the no-progress count", async () => {
    let polls = 0;
    const tools = wrap({
      process: { execute: () => { polls++; return { output: polls <= 10 ? "same" : `new-${polls}` }; } },
    });
    for (let i = 0; i < 30; i++) {
      const out = await run(tools.process, { action: "poll", id: "alive" });
      expect(typeof out, `poll ${i + 1} executed`).toBe("object");
    }
    expect(polls).toBe(30); // progress after call 10 → never blocked
  });

  it("hashes long outputs on their first 1000 chars — tail-only churn still counts as no progress", async () => {
    let polls = 0;
    const head = "H".repeat(1500);
    const tools = wrap({
      // Identical first 1000 chars; the differing tail is beyond the
      // normalizeNoProgressValue truncation, so the hash must not change.
      process: { execute: () => { polls++; return { output: head + `tick-${polls}` }; } },
    });
    for (let i = 0; i < 16; i++) {
      await run(tools.process, { action: "poll", id: "tail-churn" });
    }
    const blocked = await run(tools.process, { action: "poll", id: "tail-churn" });
    expect(String(blocked)).toContain("no-progress polling loop");
    expect(polls).toBe(16);
  });
});

describe("DAG tool-node events (dagContext)", () => {
  type PublishedNode = { swarmNode: { status: string; taskSummary: string; toolName?: string } };

  it("publishes running + completed with the input-derived summary (code field)", async () => {
    const tools = applyGlobalToolLoopGuard(
      { runner: { execute: async () => "ok" } } as never,
      { chatId: "chat-1" }
    ) as unknown as Record<string, AnyTool>;
    const code = "C".repeat(120);
    await run(tools.runner, { code });

    expect(publishMock).toHaveBeenCalledTimes(2);
    const [start, done] = publishMock.mock.calls.map((c) => c[0] as unknown as PublishedNode);
    expect(start.swarmNode.status).toBe("running");
    expect(start.swarmNode.taskSummary).toBe(code.slice(0, 80));
    expect(done.swarmNode.status).toBe("completed");
  });

  it("derives the summary from query/message fields and falls back to the tool name", async () => {
    const tools = applyGlobalToolLoopGuard(
      { probe: { execute: async () => "ok" } } as never,
      { chatId: "chat-1" }
    ) as unknown as Record<string, AnyTool>;

    await run(tools.probe, { query: "find things" });
    await run(tools.probe, { message: "tell things" });
    await run(tools.probe, "bare-string-input");

    const summaries = publishMock.mock.calls
      .map((c) => (c[0] as unknown as PublishedNode).swarmNode)
      .filter((n) => n.status === "running")
      .map((n) => n.taskSummary);
    expect(summaries).toEqual(["find things", "tell things", "probe"]);
  });

  it("marks the node error when the tool throws", async () => {
    const tools = applyGlobalToolLoopGuard(
      { boom: { execute: async () => { throw new Error("die"); } } } as never,
      { chatId: "chat-1" }
    ) as unknown as Record<string, AnyTool>;
    await run(tools.boom, { x: 1 });

    const statuses = publishMock.mock.calls.map(
      (c) => (c[0] as unknown as PublishedNode).swarmNode.status
    );
    expect(statuses).toEqual(["running", "error"]);
  });

  it("suppresses the START event for process/call_agent but still publishes completion", async () => {
    const tools = applyGlobalToolLoopGuard(
      { process: { execute: async () => ({ output: "polling" }) } } as never,
      { chatId: "chat-1" }
    ) as unknown as Record<string, AnyTool>;
    await run(tools.process, { action: "poll", id: "p1" });

    expect(publishMock).toHaveBeenCalledTimes(1);
    const only = publishMock.mock.calls[0][0] as unknown as PublishedNode;
    expect(only.swarmNode.status).toBe("completed");
  });

  it("publishes nothing without a dagContext", async () => {
    const tools = wrap({ silent: { execute: async () => "ok" } });
    await run(tools.silent, { x: 1 });
    expect(publishMock).not.toHaveBeenCalled();
  });
});
