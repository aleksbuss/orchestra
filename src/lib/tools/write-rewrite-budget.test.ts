import { describe, it, expect, beforeEach } from "vitest";
import { recordFileWrite, resetRewriteBudget } from "@/lib/tools/write-rewrite-budget";

describe("recordFileWrite — chat-scoped rewrite budget (PM #80 cross-turn backstop)", () => {
  beforeEach(() => resetRewriteBudget());

  it("allows the first writes, warns at the warn threshold (6)", () => {
    const f = "/proj/src/payload.ts";
    for (let i = 1; i <= 5; i++) {
      expect(recordFileWrite("chatA", f).action).toBe("allow");
    }
    const sixth = recordFileWrite("chatA", f);
    expect(sixth.action).toBe("warn");
    expect(sixth.count).toBe(6);
    expect(sixth.message).toContain("STOP rewriting the whole file");
  });

  it("blocks at the block threshold (10), refusing the write", () => {
    const f = "/proj/src/payload.ts";
    let result = recordFileWrite("chatB", f);
    for (let i = 2; i <= 10; i++) result = recordFileWrite("chatB", f);
    expect(result.action).toBe("block");
    expect(result.count).toBe(10);
    expect(result.message).toContain("was NOT executed");
  });

  it("resets into the warn band after a block so a real fix still has a runway", () => {
    const f = "/proj/src/payload.ts";
    for (let i = 1; i <= 10; i++) recordFileWrite("chatC", f); // 10th = block, reset to 5
    // Next write is count 6 → warn (not an immediate re-block), giving room to land a fix.
    const afterBlock = recordFileWrite("chatC", f);
    expect(afterBlock.action).toBe("warn");
    expect(afterBlock.count).toBe(6);
    // A persistent loop climbs back to 10 and is interrupted again.
    let r = afterBlock;
    for (let i = 7; i <= 10; i++) r = recordFileWrite("chatC", f);
    expect(r.action).toBe("block");
  });

  it("tracks files independently within a chat", () => {
    for (let i = 1; i <= 10; i++) recordFileWrite("chatD", "/proj/a.ts"); // a.ts → block zone
    expect(recordFileWrite("chatD", "/proj/b.ts").action).toBe("allow"); // b.ts untouched
  });

  it("tracks chats independently", () => {
    for (let i = 1; i <= 9; i++) recordFileWrite("chatE", "/proj/x.ts");
    // A different chat writing the same path starts from zero.
    expect(recordFileWrite("chatF", "/proj/x.ts").action).toBe("allow");
  });

  it("normalizes paths so ./ and // variants count as the same file", () => {
    for (let i = 1; i <= 5; i++) recordFileWrite("chatG", "/proj/src/x.ts");
    const viaMessyPath = recordFileWrite("chatG", "/proj/src/./x.ts");
    expect(viaMessyPath.action).toBe("warn");
    expect(viaMessyPath.count).toBe(6);
  });

  it("is a no-op when chatId is missing (best-effort tracking)", () => {
    for (let i = 1; i <= 20; i++) {
      const r = recordFileWrite(undefined, "/proj/src/x.ts");
      expect(r.action).toBe("allow");
      expect(r.count).toBe(0);
    }
  });

  it("bounds memory: stays usable after more than the FIFO cap of chats", () => {
    for (let i = 0; i < 600; i++) recordFileWrite(`chat-${i}`, "/proj/x.ts");
    // Oldest chats evicted; a fresh chat still behaves correctly.
    expect(recordFileWrite("chat-new", "/proj/x.ts").action).toBe("allow");
  });
});
