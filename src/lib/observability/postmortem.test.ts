/**
 * Tests for postmortem.ts.
 *
 * Pinned invariants:
 *   - `sanitizeSettingsForPostmortem` keeps provider/model but DROPS every
 *     secret. The list-presence-not-value pattern guards screenshots and
 *     pm.json files shared in bug reports from leaking keys.
 *   - `dumpPostmortem` is best-effort: never throws, even when the chat
 *     file is missing, the logs dir doesn't exist, or the trace id is
 *     malformed (in which case it returns null).
 *   - `dumpPostmortem` rejects malicious traceId / chatId inputs (path-
 *     traversal class — same regex used elsewhere in this codebase).
 *   - The persisted file round-trips through `loadPostmortem` and matches
 *     the expected schema version.
 *   - `listPostmortems` returns newest-first and skips non-JSON / malformed
 *     files without crashing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { AppSettings } from "@/lib/types";
import type { ChatErrorPayload } from "@/lib/realtime/types";
import {
  MAX_POSTMORTEMS,
  POSTMORTEM_SCHEMA_VERSION,
  dumpPostmortem,
  listPostmortems,
  loadPostmortem,
  prunePostmortems,
  sanitizeSettingsForPostmortem,
} from "./postmortem";

let tmpRoot: string;
let cwdSpy: any;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-pm-test-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
});

afterEach(async () => {
  cwdSpy?.mockRestore();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const sampleSettings = (): AppSettings => ({
  chatModel: {
    provider: "openrouter",
    model: "qwen/qwen-2.5-coder-32b-instruct",
    apiKey: "sk-real-OPENROUTER",
    authMethod: "api_key",
  },
  utilityModel: {
    provider: "openrouter",
    model: "google/gemma-4-31b-it",
    apiKey: "sk-real-utility-key",
  },
  embeddingsModel: {
    provider: "openai",
    model: "text-embedding-3-small",
    apiKey: "sk-real-OPENAI",
    dimensions: 1536,
  },
  codeExecution: { enabled: true, timeout: 600, maxOutputLength: 120000 },
  memory: {
    enabled: true,
    similarityThreshold: 0.35,
    maxResults: 10,
    chunkSize: 400,
  },
  search: { enabled: true, provider: "tavily", apiKey: "tvly-real-key" },
  general: { darkMode: false, language: "en" },
  auth: {
    enabled: true,
    username: "admin",
    passwordHash: "scrypt$abc$REAL_HASH_DO_NOT_LEAK",
    mustChangeCredentials: false,
  },
  providerApiKeys: {
    openai: "sk-OPENAI-real",
    anthropic: "sk-ant-real",
    google: "",
  },
});

const sampleClassification: ChatErrorPayload = {
  traceId: "T-test",
  kind: "upstream_no_tools",
  message: "tool calls not supported",
  hint: "switch model",
  recoverable: false,
};

describe("sanitizeSettingsForPostmortem — secret stripping", () => {
  it("keeps provider/model but drops chatModel.apiKey", () => {
    const out = sanitizeSettingsForPostmortem(sampleSettings());
    expect(out.chatModel.provider).toBe("openrouter");
    expect(out.chatModel.model).toBe("qwen/qwen-2.5-coder-32b-instruct");
    // The whole serialized object must not contain the real key.
    expect(JSON.stringify(out)).not.toContain("sk-real-OPENROUTER");
    expect(JSON.stringify(out)).not.toContain("sk-real-utility-key");
  });

  it("never embeds passwordHash, even when settings carries one", () => {
    const out = sanitizeSettingsForPostmortem(sampleSettings());
    expect(JSON.stringify(out)).not.toContain("REAL_HASH_DO_NOT_LEAK");
    expect(JSON.stringify(out)).not.toContain("scrypt$");
    expect(JSON.stringify(out)).not.toMatch(/passwordHash/i);
  });

  it("captures provider-key PRESENCE without ever leaking values", () => {
    const out = sanitizeSettingsForPostmortem(sampleSettings());
    expect(out.providerApiKeysPresent.sort()).toEqual(["anthropic", "openai"]);
    // google's key is empty string in the input, so it's not in the list.
    expect(out.providerApiKeysPresent).not.toContain("google");
    // Values themselves must not appear anywhere.
    expect(JSON.stringify(out)).not.toContain("sk-OPENAI-real");
    expect(JSON.stringify(out)).not.toContain("sk-ant-real");
  });

  it("flags chatModelApiKeyPresent without leaking the key", () => {
    const settings = sampleSettings();
    expect(sanitizeSettingsForPostmortem(settings).chatModelApiKeyPresent).toBe(true);
    delete settings.chatModel.apiKey;
    expect(sanitizeSettingsForPostmortem(settings).chatModelApiKeyPresent).toBe(false);
  });

  it("captures search provider but not its apiKey", () => {
    const out = sanitizeSettingsForPostmortem(sampleSettings());
    expect(out.searchProvider).toBe("tavily");
    expect(JSON.stringify(out)).not.toContain("tvly-real-key");
  });
});

describe("dumpPostmortem — happy path", () => {
  it("writes data/postmortems/<traceId>.json with the full schema", async () => {
    const filePath = await dumpPostmortem({
      traceId: "T-1",
      chatId: "c-1",
      projectId: "p-1",
      request: {
        userMessage: "test prompt",
        swarmEnabled: true,
        preset: "custom",
        currentPath: "src/foo",
      },
      settings: sampleSettings(),
      errorClassification: sampleClassification,
      err: new Error("boom"),
    });

    expect(filePath).not.toBeNull();
    const pm = await loadPostmortem("T-1");
    expect(pm).not.toBeNull();
    expect(pm?.schemaVersion).toBe(POSTMORTEM_SCHEMA_VERSION);
    expect(pm?.traceId).toBe("T-1");
    expect(pm?.chatId).toBe("c-1");
    expect(pm?.projectId).toBe("p-1");
    expect(pm?.request.userMessage).toBe("test prompt");
    expect(pm?.errorClassification.kind).toBe("upstream_no_tools");
    expect(pm?.rawError.message).toBe("boom");
    expect(typeof pm?.rawError.stack).toBe("string");
  });

  it("dumps even when the chat file is missing — chatSnapshotOmittedReason='missing'", async () => {
    await dumpPostmortem({
      traceId: "T-orphan",
      chatId: "c-never-existed",
      request: { userMessage: "x", swarmEnabled: false },
      settings: sampleSettings(),
      errorClassification: sampleClassification,
      err: new Error("x"),
    });
    const pm = await loadPostmortem("T-orphan");
    expect(pm?.chatSnapshot).toBeNull();
    expect(pm?.chatSnapshotOmittedReason).toBe("missing");
  });

  it("embeds chat snapshot when the file exists", async () => {
    // Plant a chat file; dump should pick it up.
    const chatsDir = path.join(tmpRoot, "data", "chats");
    await fs.mkdir(chatsDir, { recursive: true });
    await fs.writeFile(
      path.join(chatsDir, "c-1.json"),
      JSON.stringify({ id: "c-1", messages: [{ role: "user", content: "hi" }] }),
      "utf-8"
    );

    await dumpPostmortem({
      traceId: "T-with-chat",
      chatId: "c-1",
      request: { userMessage: "x", swarmEnabled: false },
      settings: sampleSettings(),
      errorClassification: sampleClassification,
      err: new Error("x"),
    });

    const pm = await loadPostmortem("T-with-chat");
    expect(pm?.chatSnapshot).toMatchObject({ id: "c-1" });
    expect(pm?.chatSnapshotOmittedReason).toBeUndefined();
  });

  it("degrades to 'oversize' for chats above the embed cap", async () => {
    const chatsDir = path.join(tmpRoot, "data", "chats");
    await fs.mkdir(chatsDir, { recursive: true });
    // Write a 500KB chat (above the 250KB cap).
    const huge = JSON.stringify({ id: "c-huge", messages: ["x".repeat(500_000)] });
    await fs.writeFile(path.join(chatsDir, "c-huge.json"), huge, "utf-8");

    await dumpPostmortem({
      traceId: "T-huge",
      chatId: "c-huge",
      request: { userMessage: "x", swarmEnabled: false },
      settings: sampleSettings(),
      errorClassification: sampleClassification,
      err: new Error("x"),
    });

    const pm = await loadPostmortem("T-huge");
    expect(pm?.chatSnapshot).toBeNull();
    expect(pm?.chatSnapshotOmittedReason).toBe("oversize");
  });

  it("the persisted file does NOT contain any of the secrets from settings", async () => {
    await dumpPostmortem({
      traceId: "T-secrets",
      chatId: "c-1",
      request: { userMessage: "x", swarmEnabled: false },
      settings: sampleSettings(),
      errorClassification: sampleClassification,
      err: new Error("x"),
    });

    const raw = await fs.readFile(
      path.join(tmpRoot, "data", "postmortems", "T-secrets.json"),
      "utf-8"
    );
    expect(raw).not.toContain("sk-real-OPENROUTER");
    expect(raw).not.toContain("REAL_HASH_DO_NOT_LEAK");
    expect(raw).not.toContain("tvly-real-key");
    expect(raw).not.toContain("sk-OPENAI-real");
  });
});

describe("dumpPostmortem — defensive contracts", () => {
  it("never throws on a malformed traceId; returns null", async () => {
    const result = await dumpPostmortem({
      traceId: "../../etc/passwd",
      chatId: "c-1",
      request: { userMessage: "x", swarmEnabled: false },
      settings: sampleSettings(),
      errorClassification: sampleClassification,
      err: new Error("x"),
    });
    expect(result).toBeNull();
  });

  it("never throws on a malformed chatId; returns null", async () => {
    const result = await dumpPostmortem({
      traceId: "T-ok",
      chatId: "../evil",
      request: { userMessage: "x", swarmEnabled: false },
      settings: sampleSettings(),
      errorClassification: sampleClassification,
      err: new Error("x"),
    });
    expect(result).toBeNull();
  });

  it("returns the absolute path on success (caller can log it)", async () => {
    const filePath = await dumpPostmortem({
      traceId: "T-path",
      chatId: "c-1",
      request: { userMessage: "x", swarmEnabled: false },
      settings: sampleSettings(),
      errorClassification: sampleClassification,
      err: new Error("x"),
    });
    expect(typeof filePath).toBe("string");
    expect(filePath?.endsWith("T-path.json")).toBe(true);
  });

  it("captures non-Error throws as a stringified message (no crash)", async () => {
    await dumpPostmortem({
      traceId: "T-string-err",
      chatId: "c-1",
      request: { userMessage: "x", swarmEnabled: false },
      settings: sampleSettings(),
      errorClassification: sampleClassification,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      err: "plain string thrown" as any,
    });
    const pm = await loadPostmortem("T-string-err");
    expect(pm?.rawError.message).toBe("plain string thrown");
  });
});

describe("loadPostmortem", () => {
  it("returns null for a missing file", async () => {
    expect(await loadPostmortem("T-nope")).toBeNull();
  });

  it("returns null for a malformed traceId (defense-in-depth)", async () => {
    expect(await loadPostmortem("../../etc/passwd")).toBeNull();
  });

  it("returns null on corrupted JSON instead of throwing", async () => {
    const dir = path.join(tmpRoot, "data", "postmortems");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "T-corrupt.json"), "{ broken", "utf-8");
    expect(await loadPostmortem("T-corrupt")).toBeNull();
  });
});

describe("listPostmortems", () => {
  it("returns [] when the directory is missing (fresh install)", async () => {
    expect(await listPostmortems()).toEqual([]);
  });

  it("returns newest-first by ts", async () => {
    for (const id of ["T-a", "T-b", "T-c"]) {
      await dumpPostmortem({
        traceId: id,
        chatId: "c-1",
        request: { userMessage: "x", swarmEnabled: false },
        settings: sampleSettings(),
        errorClassification: { ...sampleClassification, traceId: id },
        err: new Error("x"),
      });
      // 5ms gap so timestamps differ.
      await new Promise((r) => setTimeout(r, 5));
    }
    const out = await listPostmortems();
    expect(out.map((e) => e.traceId)).toEqual(["T-c", "T-b", "T-a"]);
  });

  it("skips non-.json and corrupt files without crashing", async () => {
    await dumpPostmortem({
      traceId: "T-good",
      chatId: "c-1",
      request: { userMessage: "x", swarmEnabled: false },
      settings: sampleSettings(),
      errorClassification: sampleClassification,
      err: new Error("x"),
    });

    const dir = path.join(tmpRoot, "data", "postmortems");
    await fs.writeFile(path.join(dir, "stale.lock"), "x", "utf-8");
    await fs.writeFile(path.join(dir, "T-corrupt.json"), "{ broken", "utf-8");

    const out = await listPostmortems();
    expect(out.map((e) => e.traceId)).toEqual(["T-good"]);
  });

  it("surfaces the error kind + message for triage", async () => {
    await dumpPostmortem({
      traceId: "T-triage",
      chatId: "c-1",
      request: { userMessage: "x", swarmEnabled: false },
      settings: sampleSettings(),
      errorClassification: {
        traceId: "T-triage",
        kind: "upstream_rate_limit",
        message: "Slow down",
        recoverable: true,
      },
      err: new Error("x"),
    });
    const out = await listPostmortems();
    expect(out[0]).toMatchObject({
      traceId: "T-triage",
      kind: "upstream_rate_limit",
      message: "Slow down",
    });
  });
});

describe("prunePostmortems — FIFO ring buffer (Sprint 5 follow-up)", () => {
  async function plant(name: string, mtimeMs: number): Promise<void> {
    const dir = path.join(tmpRoot, "data", "postmortems");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${name}.json`);
    await fs.writeFile(file, JSON.stringify({ traceId: name }), "utf-8");
    const secs = mtimeMs / 1000;
    await fs.utimes(file, secs, secs);
  }

  it("returns removed=0 when the directory does not exist", async () => {
    const out = await prunePostmortems();
    expect(out.removed).toBe(0);
  });

  it("returns removed=0 when count is at or below MAX_POSTMORTEMS", async () => {
    // Smallish fixture; the cap is huge (500), so under it nothing prunes.
    for (let i = 0; i < 5; i++) {
      await plant(`T-${i}`, Date.now() - i * 1000);
    }
    const out = await prunePostmortems();
    expect(out.removed).toBe(0);
  });

  it("after the live cap is exceeded, only MAX_POSTMORTEMS files remain — verified via listPostmortems", async () => {
    // Drop one extra file beyond the live cap; assert it gets evicted.
    // This is the property test that doesn't depend on shimming the const.
    const dir = path.join(tmpRoot, "data", "postmortems");
    await fs.mkdir(dir, { recursive: true });
    // Plant exactly MAX_POSTMORTEMS + 2 files. T-old-A / T-old-B are the
    // two oldest by mtime; they should be the ones evicted on prune.
    const now = Date.now();
    await plant("T-old-A", now - 1_000_000);
    await plant("T-old-B", now - 999_000);
    for (let i = 0; i < MAX_POSTMORTEMS; i++) {
      await plant(`T-fresh-${i}`, now - i);
    }

    const out = await prunePostmortems();
    expect(out.removed).toBe(2);

    const survivors = await fs.readdir(dir);
    expect(survivors).not.toContain("T-old-A.json");
    expect(survivors).not.toContain("T-old-B.json");
    expect(survivors.length).toBe(MAX_POSTMORTEMS);
  });

  it("dumpPostmortem fires the pruner inline (best-effort)", async () => {
    // Plant cap + 1 stale files, then trigger a dump — the post-dump
    // prune should bring us back to EXACTLY the cap, not "at most" it.
    //
    // Why we can't `vi.spyOn(prunePostmortems)` to prove the call:
    // dumpPostmortem invokes `prunePostmortems()` as a local reference
    // inside the same module, so spying on the module export wouldn't
    // intercept the call (the lexical resolution beats the export
    // rebinding). The strongest test we can write is the property test:
    // before-dump count = MAX+1 stale, after-dump count = exactly MAX,
    // and the fresh dump survived. If the pruner had silently not run,
    // we'd see MAX+2.
    const now = Date.now();
    for (let i = 0; i <= MAX_POSTMORTEMS; i++) {
      await plant(`T-stale-${i}`, now - 10_000 - i);
    }
    await dumpPostmortem({
      traceId: "T-fresh",
      chatId: "c-1",
      request: { userMessage: "x", swarmEnabled: false },
      settings: sampleSettings(),
      errorClassification: sampleClassification,
      err: new Error("x"),
    });
    // Pruner is fire-and-forget (.catch only), so we can't await it. A
    // fixed sleep was flaky under coverage instrumentation (the unlink
    // chain hadn't settled → 502 instead of 500). Poll until the count
    // settles to MAX, up to a generous ceiling; fail only if it never
    // does. As soon as the pruner finishes we proceed.
    const dir = path.join(tmpRoot, "data", "postmortems");
    const deadline = Date.now() + 5_000;
    let entries: string[] = [];
    let jsonCount = -1;
    do {
      entries = await fs.readdir(dir);
      jsonCount = entries.filter((e) => e.endsWith(".json")).length;
      if (jsonCount === MAX_POSTMORTEMS) break;
      await new Promise((r) => setTimeout(r, 25));
    } while (Date.now() < deadline);

    expect(jsonCount).toBe(MAX_POSTMORTEMS); // EXACT — proves the pruner ran
    expect(entries).toContain("T-fresh.json"); // the fresh dump survived
  });

  it("ties on mtimeMs sort deterministically by readdir order (documented non-spec)", async () => {
    // Edge case the reviewer asked about: what if N files share the same
    // mtimeMs? `Array.sort` is stable in V8 (Node 22), so two files with
    // identical mtime keep their readdir order — which on macOS/Linux is
    // typically inode order, deterministic per filesystem. We don't
    // assert WHICH file is evicted (that's filesystem-dependent); we
    // assert prune still removes the right COUNT and doesn't crash.
    const dir = path.join(tmpRoot, "data", "postmortems");
    await fs.mkdir(dir, { recursive: true });
    const sharedMtime = Date.now();
    const count = MAX_POSTMORTEMS + 3;
    for (let i = 0; i < count; i++) {
      await plant(`T-eq-${i}`, sharedMtime); // ALL identical mtime
    }
    const out = await prunePostmortems();
    expect(out.removed).toBe(3);
    const survivors = await fs.readdir(dir);
    expect(survivors.filter((e) => e.endsWith(".json")).length).toBe(
      MAX_POSTMORTEMS
    );
  });
});
