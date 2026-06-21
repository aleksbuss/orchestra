import { describe, it, expect } from "vitest";
import { applyGlobalToolLoopGuard } from "./tool-guard";

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
