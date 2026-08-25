/**
 * `/api/health` must survive a throwing probe.
 *
 * The endpoint's whole job is to stay answerable when something is broken, so a
 * probe that throws has to degrade to a `warn` row — never take the response to
 * 500. Sixteen of its eighteen probes already did that. Two did not: the
 * circuit-breaker snapshot and the chat-index integrity check were the only
 * top-level calls in a 768-line handler with no try/catch of their own and no
 * outer one.
 *
 * Honest framing, because it belongs in the record: this is HARDENING, not a
 * repair. A single `500` was observed from a live server during the 2026-08-25
 * audit and could not be reproduced across 27 subsequent requests, and no
 * mechanism was ever identified. What is pinned here is the property the
 * endpoint should have had either way.
 *
 * These two probes are mocked at module scope; every other probe runs for real,
 * which is also why this lives in its own file rather than in `route.test.ts`
 * (that suite pins the happy-path subsystem list and must not see these mocks).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/agent/model-health", () => ({
  getModelHealthSnapshot: vi.fn(),
  recordModelSuccess: vi.fn(),
  recordModelFailure: vi.fn(),
}));
vi.mock("@/lib/storage/chat-store", () => ({
  getBrokenChatFiles: vi.fn(),
  getOrphanIndexEntries: vi.fn(),
}));

import { GET } from "./route";
import { getModelHealthSnapshot } from "@/lib/agent/model-health";
import { getBrokenChatFiles, getOrphanIndexEntries } from "@/lib/storage/chat-store";

const mockedSnapshot = vi.mocked(getModelHealthSnapshot);
const mockedBroken = vi.mocked(getBrokenChatFiles);
const mockedOrphans = vi.mocked(getOrphanIndexEntries);

type Subsystem = { name: string; status: string; detail?: string };

async function subsystems(): Promise<{ status: number; body: { status: string; subsystems: Subsystem[] } }> {
  const res = await GET();
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSnapshot.mockReturnValue([]);
  mockedBroken.mockReturnValue([]);
  mockedOrphans.mockResolvedValue([]);
});

describe("/api/health — a throwing probe degrades to warn, never to 500", () => {
  it("baseline: with both probes healthy the endpoint answers 200 and reports them ok", async () => {
    // Proves the instrument: if this were already failing for an unrelated
    // reason, the cases below would pass while testing nothing.
    const { status, body } = await subsystems();
    expect(status).toBe(200);
    const names = body.subsystems.map((s) => s.name);
    expect(names).toContain("model_endpoints");
    expect(names).toContain("chat_index_integrity");
  });

  it("a throwing circuit-breaker snapshot yields a warn row, not a 500", async () => {
    mockedSnapshot.mockImplementation(() => {
      throw new TypeError("breaker state unavailable");
    });
    const { status, body } = await subsystems();
    expect(status).toBe(200);
    const row = body.subsystems.find((s) => s.name === "model_endpoints");
    expect(row?.status).toBe("warn");
    // Generic by design — this endpoint is unauthenticated, so an error's own
    // message (which can carry filesystem paths) must not be echoed.
    expect(row?.detail).toContain("TypeError");
    expect(row?.detail).not.toContain("breaker state unavailable");
  });

  it("a rejecting chat-index probe yields a warn row, not a 500", async () => {
    mockedOrphans.mockRejectedValue(new Error("/Users/someone/secret/path: EACCES"));
    const { status, body } = await subsystems();
    expect(status).toBe(200);
    const row = body.subsystems.find((s) => s.name === "chat_index_integrity");
    expect(row?.status).toBe("warn");
    expect(row?.detail).not.toContain("/Users/someone/secret/path");
  });

  it("a throwing probe makes the overall status degraded, not silently healthy", async () => {
    mockedBroken.mockImplementation(() => {
      throw new Error("index unreadable");
    });
    const { body } = await subsystems();
    expect(body.status).toBe("degraded");
  });

  it("both probes throwing at once still answers, with both rows present", async () => {
    mockedSnapshot.mockImplementation(() => {
      throw new Error("a");
    });
    mockedOrphans.mockRejectedValue(new Error("b"));
    const { status, body } = await subsystems();
    expect(status).toBe(200);
    expect(body.subsystems.filter((s) => s.status === "warn").map((s) => s.name)).toEqual(
      expect.arrayContaining(["model_endpoints", "chat_index_integrity"])
    );
  });
});
