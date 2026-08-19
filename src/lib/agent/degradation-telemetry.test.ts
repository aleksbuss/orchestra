/**
 * PM #109 — tool-channel degradation telemetry.
 *
 * The regression these pin: for three post-mortems the runtime knew a model had
 * dropped the native tool channel but recorded only an in-memory boolean, at one
 * of three detection sites. Every proposal to move the compaction threshold was
 * therefore a guess. These tests hold the two properties that make the boundary
 * measurable: the chat is flagged AND an event carrying the causal variables is
 * emitted, and telemetry can never fail the turn it describes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `vi.mock` is hoisted above the module scope, so the spy must be too.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
}));

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  argumentByteSize,
  capEventLines,
  isChatDegraded,
  readUpstreamProvider,
  recordChatDegradation,
  recordToolChannelDegradation,
  resetChatDegradation,
} from "./degradation-telemetry";

/** Live-tree path the ring WOULD use; read-only here, to prove we never write it. */
async function readDegradationFile(): Promise<string | null> {
  const file = path.join(
    process.env.ORCHESTRA_DATA_DIR || path.join(process.cwd(), "data"),
    "telemetry",
    "tool-channel-degradation.jsonl"
  );
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
}

beforeEach(() => {
  warn.mockReset();
  resetChatDegradation();
});
afterEach(() => resetChatDegradation());

describe("degraded-chat flag (PM #82, moved here by PM #109)", () => {
  it("flags and clears per chat, and ignores a missing id", () => {
    expect(isChatDegraded("a")).toBe(false);
    recordChatDegradation("a");
    expect(isChatDegraded("a")).toBe(true);
    expect(isChatDegraded("b")).toBe(false);
    resetChatDegradation("a");
    expect(isChatDegraded("a")).toBe(false);

    recordChatDegradation(undefined);
    expect(isChatDegraded(undefined)).toBe(false);
  });
});

describe("recordToolChannelDegradation", () => {
  it("flags the chat AND emits one event carrying the causal variables", () => {
    recordToolChannelDegradation({
      stage: "forced-answer",
      chatId: "c1",
      provider: "openrouter",
      model: "dots-studio/dots-3-note-preview:free",
      toolName: "write_text_file",
      argBytes: 16303,
      markupChars: 16400,
      contextTokensEstimate: 53464,
      promptTokens: 51890,
      upstreamProvider: "AtlasCloud",
    });

    // The flag is what arms the halved compaction threshold on the NEXT turn —
    // the half that was missing at this site.
    expect(isChatDegraded("c1")).toBe(true);

    expect(warn).toHaveBeenCalledTimes(1);
    const [event, fields] = warn.mock.calls[0];
    expect(event).toBe("tool_channel_degradation");
    expect(fields).toMatchObject({
      stage: "forced-answer",
      chatId: "c1",
      model: "dots-studio/dots-3-note-preview:free",
      toolName: "write_text_file",
      argBytes: 16303,
      contextTokensEstimate: 53464,
      promptTokens: 51890,
      upstreamProvider: "AtlasCloud",
    });
  });

  it("never throws when logging fails — telemetry must not break the turn", () => {
    warn.mockImplementationOnce(() => {
      throw new Error("log stream closed");
    });
    expect(() =>
      recordToolChannelDegradation({ stage: "main-turn", chatId: "c2" })
    ).not.toThrow();
    // The flag still landed: it is recorded BEFORE the logging attempt.
    expect(isChatDegraded("c2")).toBe(true);
  });
});

describe("readUpstreamProvider", () => {
  it("extracts the upstream from a provider-metadata block", () => {
    expect(
      readUpstreamProvider({ providerMetadata: { openrouter: { provider: "AtlasCloud" } } })
    ).toBe("AtlasCloud");
  });

  it("returns undefined for anything that does not carry one", () => {
    expect(readUpstreamProvider(undefined)).toBeUndefined();
    expect(readUpstreamProvider(null)).toBeUndefined();
    expect(readUpstreamProvider({})).toBeUndefined();
    expect(readUpstreamProvider({ providerMetadata: "nope" })).toBeUndefined();
    expect(readUpstreamProvider({ providerMetadata: { openrouter: {} } })).toBeUndefined();
    expect(
      readUpstreamProvider({ providerMetadata: { openrouter: { provider: 7 } } })
    ).toBeUndefined();
  });
});

describe("persisted ring", () => {
  it("keeps only the newest events and drops blank lines", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `e${i}`);
    const kept = capEventLines(["", ...lines, "  "], 5);
    expect(kept).toEqual(["e7", "e8", "e9", "e10", "e11"]);
  });

  it("actually persists outside a test runner, into an ISOLATED data dir", async () => {
    // The skip-under-test guard above would also pass if persistence were
    // simply broken, so prove the apparatus works: drop the guard's env
    // markers, point the data root at a throwaway dir, and read the file back.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-degradation-"));
    const prev = {
      VITEST: process.env.VITEST,
      NODE_ENV: process.env.NODE_ENV,
      ORCHESTRA_DATA_DIR: process.env.ORCHESTRA_DATA_DIR,
    };
    try {
      // `NODE_ENV` is typed read-only; this test deliberately simulates a
      // non-test process, so go through a mutable view of the env.
      const env = process.env as Record<string, string | undefined>;
      delete env.VITEST;
      env.NODE_ENV = "development";
      env.ORCHESTRA_DATA_DIR = tmp;

      recordToolChannelDegradation({
        stage: "reissue",
        chatId: "persisted",
        model: "m1",
        argBytes: 16303,
      });
      // Fire-and-forget write; poll briefly rather than racing it.
      const file = path.join(tmp, "telemetry", "tool-channel-degradation.jsonl");
      let raw = "";
      for (let i = 0; i < 50 && !raw; i++) {
        await new Promise((r) => setTimeout(r, 10));
        raw = await fs.readFile(file, "utf-8").catch(() => "");
      }
      const rows = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        stage: "reissue",
        chatId: "persisted",
        model: "m1",
        argBytes: 16303,
      });
      expect(typeof rows[0].ts).toBe("string");
    } finally {
      const env = process.env as Record<string, string | undefined>;
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("writes NOTHING under a test runner — a unit test must never touch live data/ (PM #100)", async () => {
    const before = await readDegradationFile();
    recordToolChannelDegradation({ stage: "main-turn", chatId: "c3" });
    // The write is fire-and-forget; give the microtask queue a turn.
    await new Promise((r) => setTimeout(r, 20));
    expect(await readDegradationFile()).toBe(before);
  });
});

describe("argumentByteSize", () => {
  it("measures the serialized argument record", () => {
    expect(argumentByteSize({ a: "bc" })).toBe(JSON.stringify({ a: "bc" }).length);
  });

  it("returns undefined instead of throwing on a circular argument", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(argumentByteSize(circular)).toBeUndefined();
  });
});
