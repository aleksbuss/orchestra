import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  CURRENT_SCHEMA_VERSION,
  stampSchemaVersion,
  readSchemaVersion,
  warnIfFutureSchema,
} from "./schema-version";

describe("schema-version helpers", () => {
  it("stampSchemaVersion tags the record with the current version (non-mutating)", () => {
    const orig = { id: "c1", title: "x" };
    const stamped = stampSchemaVersion(orig);
    expect(stamped.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(stamped.id).toBe("c1");
    expect("schemaVersion" in orig).toBe(false); // original untouched
  });

  it("readSchemaVersion returns the number, or undefined when absent / non-number", () => {
    expect(readSchemaVersion({ schemaVersion: 3 })).toBe(3);
    expect(readSchemaVersion({ id: "x" })).toBeUndefined();
    expect(readSchemaVersion({ schemaVersion: "2" })).toBeUndefined();
    expect(readSchemaVersion(null)).toBeUndefined();
    expect(readSchemaVersion("str")).toBeUndefined();
  });

  it("warnIfFutureSchema flags + warns ONLY for a newer schema", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(warnIfFutureSchema({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }, "chat z")).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("NEWER Orchestra schema");

      warn.mockClear();
      expect(warnIfFutureSchema({ schemaVersion: CURRENT_SCHEMA_VERSION }, "x")).toBe(false);
      expect(warnIfFutureSchema({ schemaVersion: CURRENT_SCHEMA_VERSION - 1 }, "x")).toBe(false);
      expect(warnIfFutureSchema({ id: "no-version" }, "x")).toBe(false); // pre-stamp file
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// Wiring proof against the REAL chat-store: the stamp is written to disk, and a
// future-stamped file loads clean (envelope stripped by Zod) while warning.
describe("schema-version wiring (chat-store, isolated ORCHESTRA_DATA_DIR)", () => {
  let dataDir: string;
  let savedDataDir: string | undefined;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "orch-schema-"));
    savedDataDir = process.env.ORCHESTRA_DATA_DIR;
    process.env.ORCHESTRA_DATA_DIR = dataDir;
    vi.resetModules(); // chat-store caches DATA_DIR at module load
  });
  afterEach(async () => {
    if (savedDataDir === undefined) delete process.env.ORCHESTRA_DATA_DIR;
    else process.env.ORCHESTRA_DATA_DIR = savedDataDir;
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it("stamps schemaVersion into the on-disk chat JSON", async () => {
    const { createChat, updateChat, flushAllPendingChats } = await import("./chat-store");
    await createChat("sv1", "t");
    await updateChat("sv1", (c) => {
      c.messages.push({ id: "m1", role: "user", content: "hi", createdAt: "1" });
      return c;
    });
    await flushAllPendingChats();
    const raw = JSON.parse(await fs.readFile(path.join(dataDir, "chats", "sv1.json"), "utf-8"));
    expect(raw.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("loads a FUTURE-stamped chat clean (envelope stripped) and warns", async () => {
    const { getChat } = await import("./chat-store");
    await fs.mkdir(path.join(dataDir, "chats"), { recursive: true });
    // Hand-write a chat from a "newer build": schemaVersion + an unknown field.
    await fs.writeFile(
      path.join(dataDir, "chats", "future.json"),
      JSON.stringify({
        id: "future",
        title: "from the future",
        messages: [],
        createdAt: "1",
        updatedAt: "1",
        schemaVersion: CURRENT_SCHEMA_VERSION + 5,
        someFutureField: { nested: true },
      })
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const chat = await getChat("future");
      expect(chat?.id).toBe("future"); // loaded, not rejected
      expect((chat as unknown as Record<string, unknown>)?.schemaVersion).toBeUndefined(); // stripped
      expect(warn.mock.calls.some((c) => String(c[0]).includes("NEWER Orchestra schema"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
