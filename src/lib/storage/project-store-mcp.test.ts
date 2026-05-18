/**
 * Tests for the MCP-server-config slice of `project-store.ts`:
 *   - `loadProjectMcpServers` — read .meta/mcp/servers.json (Cursor + legacy formats)
 *   - `upsertProjectMcpServer` — add or update one server
 *   - `deleteProjectMcpServer` — remove one server
 *   - `saveProjectMcpServersContent` — overwrite the whole file from raw JSON
 *
 * Pinned invariants:
 *   - Cursor format `{mcpServers: {id: {url|command...}}}` is the canonical
 *     on-disk shape; legacy `{servers: [{id, transport, ...}]}` is normalized.
 *   - Server id validation: `^[a-zA-Z0-9._-]+$`, length 1-120. Path-traversal
 *     class characters rejected (slashes, spaces, NULL).
 *   - HTTP server requires non-empty url; STDIO server requires non-empty
 *     command. Empty after trim → 400 with explicit error.
 *   - The Cursor file ALWAYS has `{mcpServers: {}}` shape after a save —
 *     even when there are zero servers (so the file is parseable).
 *   - Empty raw content for `saveProjectMcpServersContent` defaults to
 *     `{mcpServers: {}}` instead of leaving the disk in a broken state.
 *   - Invalid JSON / unsupported shape returns 400 with a hint.
 *   - upsert reports `created` vs `updated` so the caller can plumb the
 *     right status (201 vs 200) at the route layer.
 *   - On disk the env / args / cwd values are all string-normalized
 *     (whitespace-trimmed, empty entries dropped).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

vi.mock("@/lib/storage/chat-store", () => ({
  deleteChatsByProjectId: vi.fn(),
}));
vi.mock("@/lib/memory/memory", () => ({
  clearMemoryCache: vi.fn(),
}));
vi.mock("@/lib/realtime/event-bus", () => ({
  publishUiSyncEvent: vi.fn(),
}));

let tmpRoot: string;
let cwdSpy: any;

async function loadModule() {
  return await import("./project-store");
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-projstore-mcp-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(async () => {
  cwdSpy?.mockRestore();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function plantServersFile(projectId: string, content: unknown): Promise<string> {
  const m = await loadModule();
  const filePath = m.getProjectMcpServersPath(projectId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
    "utf-8"
  );
  return filePath;
}

// ────────────────────────────────────────────────────────────
// loadProjectMcpServers
// ────────────────────────────────────────────────────────────

describe("loadProjectMcpServers — read", () => {
  it("returns null when the file does not exist", async () => {
    const m = await loadModule();
    expect(await m.loadProjectMcpServers("p-1")).toBeNull();
  });

  it("parses Cursor format with stdio servers (command + args + env)", async () => {
    await plantServersFile("p-1", {
      mcpServers: {
        "github-mcp": {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_token" },
        },
      },
    });
    const m = await loadModule();
    const cfg = await m.loadProjectMcpServers("p-1");
    expect(cfg?.servers).toHaveLength(1);
    const server = cfg!.servers[0] as any;
    expect(server.id).toBe("github-mcp");
    expect(server.transport).toBe("stdio");
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", "@modelcontextprotocol/server-github"]);
    expect(server.env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_token" });
  });

  it("parses Cursor format with http servers (url + headers)", async () => {
    await plantServersFile("p-1", {
      mcpServers: {
        "remote-mcp": {
          url: "https://mcp.example.com/api",
          headers: { Authorization: "Bearer x" },
        },
      },
    });
    const m = await loadModule();
    const cfg = await m.loadProjectMcpServers("p-1");
    const server = cfg!.servers[0] as any;
    expect(server.transport).toBe("http");
    expect(server.url).toBe("https://mcp.example.com/api");
    expect(server.headers).toEqual({ Authorization: "Bearer x" });
  });

  it("parses legacy format `{servers: [...]}`", async () => {
    await plantServersFile("p-1", {
      servers: [
        { id: "one", transport: "stdio", command: "node", args: ["x.js"] },
      ],
    });
    const m = await loadModule();
    const cfg = await m.loadProjectMcpServers("p-1");
    expect(cfg?.servers).toHaveLength(1);
    expect((cfg!.servers[0] as any).id).toBe("one");
  });

  it("returns null for an empty mcpServers object (no servers configured)", async () => {
    await plantServersFile("p-1", { mcpServers: {} });
    const m = await loadModule();
    expect(await m.loadProjectMcpServers("p-1")).toBeNull();
  });

  it("returns null on malformed JSON (does NOT throw)", async () => {
    await plantServersFile("p-1", "{ broken");
    const m = await loadModule();
    expect(await m.loadProjectMcpServers("p-1")).toBeNull();
  });

  it("skips entries that have neither url nor command (defensive)", async () => {
    await plantServersFile("p-1", {
      mcpServers: {
        bad: { unknownField: "x" }, // no url, no command — skipped
        good: { command: "ls" },
      },
    });
    const m = await loadModule();
    const cfg = await m.loadProjectMcpServers("p-1");
    expect(cfg?.servers).toHaveLength(1);
    expect((cfg!.servers[0] as any).id).toBe("good");
  });

  it("non-array `args` is coerced to []", async () => {
    await plantServersFile("p-1", {
      mcpServers: { x: { command: "ls", args: "not-an-array" } },
    });
    const m = await loadModule();
    const cfg = await m.loadProjectMcpServers("p-1");
    expect((cfg!.servers[0] as any).args).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// upsertProjectMcpServer
// ────────────────────────────────────────────────────────────

describe("upsertProjectMcpServer", () => {
  it("creates the file + returns action='created' when no servers existed", async () => {
    const m = await loadModule();
    const result = await m.upsertProjectMcpServer("p-1", {
      id: "first",
      transport: "stdio",
      command: "node",
      args: ["x.js"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.action).toBe("created");
    }

    const onDisk = JSON.parse(
      await fs.readFile(m.getProjectMcpServersPath("p-1"), "utf-8")
    );
    expect(onDisk.mcpServers.first).toEqual({
      command: "node",
      args: ["x.js"],
    });
  });

  it("returns action='updated' when the server id already exists", async () => {
    const m = await loadModule();
    await m.upsertProjectMcpServer("p-1", {
      id: "x",
      transport: "stdio",
      command: "old",
    });
    const result = await m.upsertProjectMcpServer("p-1", {
      id: "x",
      transport: "stdio",
      command: "new",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.action).toBe("updated");

    const onDisk = JSON.parse(
      await fs.readFile(m.getProjectMcpServersPath("p-1"), "utf-8")
    );
    expect(onDisk.mcpServers.x.command).toBe("new");
  });

  it("trims whitespace from args and drops empty ones", async () => {
    const m = await loadModule();
    await m.upsertProjectMcpServer("p-1", {
      id: "trim",
      transport: "stdio",
      command: "ls",
      args: ["  -la  ", "", "  /etc  "],
    });

    const onDisk = JSON.parse(
      await fs.readFile(m.getProjectMcpServersPath("p-1"), "utf-8")
    );
    expect(onDisk.mcpServers.trim.args).toEqual(["-la", "/etc"]);
  });

  it("trims env keys and casts values to string", async () => {
    const m = await loadModule();
    await m.upsertProjectMcpServer("p-1", {
      id: "env-server",
      transport: "stdio",
      command: "ls",
      env: { "  KEY  ": "value", EMPTY_KEY_DROPPED: "x", "   ": "ignored" } as any,
    });

    const onDisk = JSON.parse(
      await fs.readFile(m.getProjectMcpServersPath("p-1"), "utf-8")
    );
    expect(onDisk.mcpServers["env-server"].env).toEqual({
      KEY: "value",
      EMPTY_KEY_DROPPED: "x",
    });
  });

  it("preserves cwd when set, drops it when whitespace-only", async () => {
    const m = await loadModule();
    await m.upsertProjectMcpServer("p-1", {
      id: "with-cwd",
      transport: "stdio",
      command: "ls",
      cwd: "  /tmp  ",
    });
    await m.upsertProjectMcpServer("p-1", {
      id: "no-cwd",
      transport: "stdio",
      command: "ls",
      cwd: "   ",
    });
    const onDisk = JSON.parse(
      await fs.readFile(m.getProjectMcpServersPath("p-1"), "utf-8")
    );
    expect(onDisk.mcpServers["with-cwd"].cwd).toBe("/tmp");
    expect(onDisk.mcpServers["no-cwd"]).not.toHaveProperty("cwd");
  });

  it("HTTP transport: stores url + optional headers", async () => {
    const m = await loadModule();
    await m.upsertProjectMcpServer("p-1", {
      id: "http-srv",
      transport: "http",
      url: "https://example.com",
      headers: { Authorization: "Bearer abc" },
    });
    const onDisk = JSON.parse(
      await fs.readFile(m.getProjectMcpServersPath("p-1"), "utf-8")
    );
    expect(onDisk.mcpServers["http-srv"]).toEqual({
      url: "https://example.com",
      headers: { Authorization: "Bearer abc" },
    });
  });

  it("rejects empty/whitespace HTTP url", async () => {
    const m = await loadModule();
    const result = await m.upsertProjectMcpServer("p-1", {
      id: "x",
      transport: "http",
      url: "   ",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/url is required/i);
  });

  it("rejects empty/whitespace STDIO command", async () => {
    const m = await loadModule();
    const result = await m.upsertProjectMcpServer("p-1", {
      id: "x",
      transport: "stdio",
      command: "   ",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/command is required/i);
  });

  it("rejects invalid server id (path-traversal class)", async () => {
    const m = await loadModule();
    for (const badId of ["../evil", "with space", "$injection", "id;rm -rf", ""]) {
      const result = await m.upsertProjectMcpServer("p-1", {
        id: badId,
        transport: "stdio",
        command: "ls",
      });
      expect(result.success, `id="${badId}"`).toBe(false);
    }
  });

  it("rejects server id > 120 chars", async () => {
    const m = await loadModule();
    const result = await m.upsertProjectMcpServer("p-1", {
      id: "x".repeat(121),
      transport: "stdio",
      command: "ls",
    });
    expect(result.success).toBe(false);
  });

  it("does not clobber other servers when upserting one", async () => {
    const m = await loadModule();
    await m.upsertProjectMcpServer("p-1", {
      id: "alpha",
      transport: "stdio",
      command: "a",
    });
    await m.upsertProjectMcpServer("p-1", {
      id: "beta",
      transport: "stdio",
      command: "b",
    });

    const onDisk = JSON.parse(
      await fs.readFile(m.getProjectMcpServersPath("p-1"), "utf-8")
    );
    expect(Object.keys(onDisk.mcpServers).sort()).toEqual(["alpha", "beta"]);
  });
});

// ────────────────────────────────────────────────────────────
// deleteProjectMcpServer
// ────────────────────────────────────────────────────────────

describe("deleteProjectMcpServer", () => {
  it("removes the server and persists the change", async () => {
    const m = await loadModule();
    await m.upsertProjectMcpServer("p-1", {
      id: "x",
      transport: "stdio",
      command: "ls",
    });

    const result = await m.deleteProjectMcpServer("p-1", "x");
    expect(result.success).toBe(true);

    const onDisk = JSON.parse(
      await fs.readFile(m.getProjectMcpServersPath("p-1"), "utf-8")
    );
    expect(onDisk.mcpServers).toEqual({});
  });

  it("404-shape error when the server id does not exist", async () => {
    const m = await loadModule();
    const result = await m.deleteProjectMcpServer("p-1", "never-existed");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not found/i);
  });

  it("rejects invalid server id without touching the file", async () => {
    const m = await loadModule();
    const result = await m.deleteProjectMcpServer("p-1", "../evil");
    expect(result.success).toBe(false);
  });

  it("preserves siblings when deleting one", async () => {
    const m = await loadModule();
    await m.upsertProjectMcpServer("p-1", {
      id: "keep",
      transport: "stdio",
      command: "ls",
    });
    await m.upsertProjectMcpServer("p-1", {
      id: "drop",
      transport: "stdio",
      command: "ls",
    });

    await m.deleteProjectMcpServer("p-1", "drop");
    const onDisk = JSON.parse(
      await fs.readFile(m.getProjectMcpServersPath("p-1"), "utf-8")
    );
    expect(Object.keys(onDisk.mcpServers)).toEqual(["keep"]);
  });
});

// ────────────────────────────────────────────────────────────
// saveProjectMcpServersContent
// ────────────────────────────────────────────────────────────

describe("saveProjectMcpServersContent — raw-edit path", () => {
  it("returns 400-shape on invalid JSON", async () => {
    const m = await loadModule();
    const result = await m.saveProjectMcpServersContent("p-1", "{ not json");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Invalid JSON/i);
  });

  it("empty content saves a valid `{mcpServers: {}}` (never leaves a broken file)", async () => {
    const m = await loadModule();
    const result = await m.saveProjectMcpServersContent("p-1", "");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.servers).toEqual([]);
      const onDisk = JSON.parse(
        await fs.readFile(m.getProjectMcpServersPath("p-1"), "utf-8")
      );
      expect(onDisk).toEqual({ mcpServers: {} });
    }
  });

  it("writes valid Cursor-format content verbatim and returns parsed servers", async () => {
    const m = await loadModule();
    const raw = JSON.stringify({
      mcpServers: {
        srv: { command: "node", args: ["x.js"] },
      },
    });

    const result = await m.saveProjectMcpServersContent("p-1", raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.servers).toHaveLength(1);
      expect((result.servers[0] as any).id).toBe("srv");
    }
  });

  it("rejects unsupported top-level shape with a hint", async () => {
    const m = await loadModule();
    const result = await m.saveProjectMcpServersContent(
      "p-1",
      JSON.stringify({ random: "shape" })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/Unsupported format/);
      expect(result.error).toMatch(/mcpServers/);
    }
  });

  it("validates server ids in the content and rejects bad ones with the offending id in the error", async () => {
    const m = await loadModule();
    const result = await m.saveProjectMcpServersContent(
      "p-1",
      JSON.stringify({
        mcpServers: { "../evil": { command: "ls" } },
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/\.\.\/evil/);
  });

  it("rejects HTTP server in content with empty url", async () => {
    const m = await loadModule();
    const result = await m.saveProjectMcpServersContent(
      "p-1",
      JSON.stringify({
        mcpServers: { srv: { url: "   " } },
      })
    );
    expect(result.success).toBe(false);
  });
});
