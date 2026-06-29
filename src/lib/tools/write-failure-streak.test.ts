import { describe, it, expect, beforeEach } from "vitest";
import {
  checkSyntaxFailureStreak,
  recordSyntaxOutcome,
  resetSyntaxFailureStreak,
} from "./write-failure-streak";

const CHAT = "chat-1";
const FILE = "/proj/src/types.ts";

/** Record N consecutive invalid writes for one (chat, file). */
function failTimes(n: number, chat = CHAT, file = FILE): void {
  for (let i = 0; i < n; i++) recordSyntaxOutcome(chat, file, false);
}

describe("write-failure-streak", () => {
  beforeEach(() => resetSyntaxFailureStreak());

  it("allows a fresh file (no prior failures)", () => {
    const d = checkSyntaxFailureStreak(CHAT, FILE);
    expect(d.action).toBe("allow");
    expect(d.streak).toBe(0);
  });

  it("allows while below the threshold", () => {
    failTimes(3); // threshold is 4
    const d = checkSyntaxFailureStreak(CHAT, FILE);
    expect(d.action).toBe("allow");
    expect(d.streak).toBe(3);
  });

  it("blocks at the threshold (4 consecutive failures)", () => {
    failTimes(4);
    const d = checkSyntaxFailureStreak(CHAT, FILE);
    expect(d.action).toBe("block");
    expect(d.streak).toBe(4);
    expect(d.message).toContain("4 times in a row");
    expect(d.message).toContain("types.ts");
  });

  it("a valid write resets the streak to zero", () => {
    failTimes(4);
    recordSyntaxOutcome(CHAT, FILE, true);
    const d = checkSyntaxFailureStreak(CHAT, FILE);
    expect(d.action).toBe("allow");
    expect(d.streak).toBe(0);
  });

  it("a no-signal write (undefined) leaves the streak unchanged", () => {
    failTimes(4);
    recordSyntaxOutcome(CHAT, FILE, undefined); // non-source / oversized / error
    const d = checkSyntaxFailureStreak(CHAT, FILE);
    expect(d.action).toBe("block");
    expect(d.streak).toBe(4);
  });

  it("block resets into the band, guaranteeing exactly one runway write", () => {
    failTimes(4);
    // First gate: block + drop to THRESHOLD-1 (3).
    expect(checkSyntaxFailureStreak(CHAT, FILE).action).toBe("block");
    // Runway: the very next write is allowed.
    const runway = checkSyntaxFailureStreak(CHAT, FILE);
    expect(runway.action).toBe("allow");
    expect(runway.streak).toBe(3);
    // If that runway write is ALSO invalid, the streak climbs back and re-trips.
    recordSyntaxOutcome(CHAT, FILE, false); // 3 -> 4
    expect(checkSyntaxFailureStreak(CHAT, FILE).action).toBe("block");
  });

  it("a valid runway write fully recovers (streak 0, not 3)", () => {
    failTimes(4);
    expect(checkSyntaxFailureStreak(CHAT, FILE).action).toBe("block"); // -> 3
    recordSyntaxOutcome(CHAT, FILE, true); // valid runway -> 0
    const d = checkSyntaxFailureStreak(CHAT, FILE);
    expect(d.action).toBe("allow");
    expect(d.streak).toBe(0);
  });

  it("is per-file isolated", () => {
    failTimes(4, CHAT, "/a.ts");
    expect(checkSyntaxFailureStreak(CHAT, "/a.ts").action).toBe("block");
    expect(checkSyntaxFailureStreak(CHAT, "/b.ts").action).toBe("allow");
  });

  it("is per-chat isolated", () => {
    failTimes(4, "chat-A", FILE);
    expect(checkSyntaxFailureStreak("chat-A", FILE).action).toBe("block");
    expect(checkSyntaxFailureStreak("chat-B", FILE).action).toBe("allow");
  });

  it("normalizes the path key (./ and ../ collapse to the same file)", () => {
    failTimes(4, CHAT, "/proj/src/types.ts");
    const d = checkSyntaxFailureStreak(CHAT, "/proj/lib/../src/types.ts");
    expect(d.action).toBe("block");
  });

  it("is a no-op when chatId is missing", () => {
    recordSyntaxOutcome(undefined, FILE, false); // must not throw
    const d = checkSyntaxFailureStreak(undefined, FILE);
    expect(d.action).toBe("allow");
    expect(d.streak).toBe(0);
  });

  it("FIFO-prunes tracked chats past the cap (oldest evicted)", () => {
    // Record one failure for 501 distinct chats; the cap is 500, so the first
    // chat's entry is evicted and reads back as a clean streak.
    for (let i = 0; i < 501; i++) recordSyntaxOutcome(`c-${i}`, FILE, false);
    expect(checkSyntaxFailureStreak("c-0", FILE).streak).toBe(0);
    expect(checkSyntaxFailureStreak("c-500", FILE).streak).toBe(1);
  });
});
