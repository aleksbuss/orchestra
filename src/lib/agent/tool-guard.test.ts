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
