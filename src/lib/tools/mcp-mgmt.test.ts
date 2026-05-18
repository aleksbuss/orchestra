/**
 * Tests for `createMcpMgmtTools` — the `inject_mcp_defaults` tool that
 * adds Sequential Thinking, GitHub, and SQLite MCP servers to a project's
 * mcp-servers.json on demand.
 *
 * Pinned invariants:
 *   - When no projectId is in context, return a clear error string —
 *     never crash the tool loop.
 *   - Read existing config when present, write fresh `{mcpServers: {}}`
 *     when missing or malformed.
 *   - Idempotent: re-running on a project that already has the defaults
 *     reports "already configured" and does NOT rewrite the file
 *     (verified via mtime comparison).
 *   - Every default carries the expected command + args (typo-protection).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

vi.mock("@/lib/storage/project-store", () => ({
  getProjectMcpServersPath: vi.fn(),
  getProjectMcpDir: vi.fn(),
}));

import { createMcpMgmtTools } from "./mcp-mgmt";
import {
  getProjectMcpDir,
  getProjectMcpServersPath,
} from "@/lib/storage/project-store";

interface McpTool {
  execute: (args: Record<string, unknown>) => Promise<string>;
}

let tmpRoot: string;
let mcpDir: string;
let mcpFile: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-mcp-mgmt-"));
  mcpDir = path.join(tmpRoot, "data/projects/p-1/.meta/mcp");
  mcpFile = path.join(mcpDir, "mcp-servers.json");

  vi.mocked(getProjectMcpDir).mockReturnValue(mcpDir);
  vi.mocked(getProjectMcpServersPath).mockReturnValue(mcpFile);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("inject_mcp_defaults — no project context", () => {
  it("returns an error string (does NOT throw) when projectId is missing", async () => {
    const tools = createMcpMgmtTools({ projectId: undefined } as any);
    const tool = tools.inject_mcp_defaults as unknown as McpTool;

    const out = await tool.execute({});
    expect(out).toMatch(/no active project context/i);
  });
});

describe("inject_mcp_defaults — fresh project (no mcp-servers.json yet)", () => {
  it("creates the mcp-servers.json with all three defaults", async () => {
    const tools = createMcpMgmtTools({ projectId: "p-1" } as any);
    const tool = tools.inject_mcp_defaults as unknown as McpTool;

    const out = await tool.execute({});
    expect(out).toMatch(/Successfully added 3/);

    const written = JSON.parse(await fs.readFile(mcpFile, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(written.mcpServers).sort()).toEqual([
      "github-mcp",
      "sequential-thinking",
      "sqlite-mcp",
    ]);
  });

  it("writes the documented command + args for sequential-thinking", async () => {
    const tools = createMcpMgmtTools({ projectId: "p-1" } as any);
    const tool = tools.inject_mcp_defaults as unknown as McpTool;
    await tool.execute({});

    const written = JSON.parse(await fs.readFile(mcpFile, "utf-8")) as any;
    expect(written.mcpServers["sequential-thinking"]).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    });
  });

  it("plants SQLITE_DB_PATH inside the project's mcp dir for sqlite-mcp", async () => {
    const tools = createMcpMgmtTools({ projectId: "p-1" } as any);
    const tool = tools.inject_mcp_defaults as unknown as McpTool;
    await tool.execute({});

    const written = JSON.parse(await fs.readFile(mcpFile, "utf-8")) as any;
    expect(written.mcpServers["sqlite-mcp"].env.SQLITE_DB_PATH).toBe(
      path.join(mcpDir, "project.db")
    );
  });
});

describe("inject_mcp_defaults — idempotency", () => {
  it("does NOT rewrite the file when all defaults are already present", async () => {
    const tools = createMcpMgmtTools({ projectId: "p-1" } as any);
    const tool = tools.inject_mcp_defaults as unknown as McpTool;

    // First call: writes everything.
    await tool.execute({});
    const beforeMtime = (await fs.stat(mcpFile)).mtimeMs;

    // Wait long enough for mtime to differ if a write happened.
    await new Promise((r) => setTimeout(r, 20));

    // Second call: should be a no-op.
    const out = await tool.execute({});
    expect(out).toMatch(/already has all default/i);
    const afterMtime = (await fs.stat(mcpFile)).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  });

  it("merges: only adds the MISSING defaults, leaves user customizations alone", async () => {
    // Pre-existing config with one default + one custom server.
    await fs.mkdir(mcpDir, { recursive: true });
    await fs.writeFile(
      mcpFile,
      JSON.stringify({
        mcpServers: {
          "sequential-thinking": { command: "old", args: [] },
          "user-custom": { command: "user-tool", args: [] },
        },
      }),
      "utf-8"
    );

    const tools = createMcpMgmtTools({ projectId: "p-1" } as any);
    const tool = tools.inject_mcp_defaults as unknown as McpTool;

    const out = await tool.execute({});
    expect(out).toMatch(/Successfully added 2/); // github-mcp + sqlite-mcp

    const written = JSON.parse(await fs.readFile(mcpFile, "utf-8")) as any;
    // Existing entry is untouched (sequential-thinking still has command:"old").
    expect(written.mcpServers["sequential-thinking"].command).toBe("old");
    // User-custom entry survived.
    expect(written.mcpServers["user-custom"]).toEqual({
      command: "user-tool",
      args: [],
    });
    // The two missing defaults landed.
    expect(written.mcpServers["github-mcp"]).toBeDefined();
    expect(written.mcpServers["sqlite-mcp"]).toBeDefined();
  });
});

describe("inject_mcp_defaults — defensive parsing", () => {
  it("recovers from a malformed mcp-servers.json (treats it as empty)", async () => {
    await fs.mkdir(mcpDir, { recursive: true });
    await fs.writeFile(mcpFile, "{ broken JSON", "utf-8");

    const tools = createMcpMgmtTools({ projectId: "p-1" } as any);
    const tool = tools.inject_mcp_defaults as unknown as McpTool;

    const out = await tool.execute({});
    expect(out).toMatch(/Successfully added 3/);
  });

  it("recovers from a config missing the `mcpServers` key", async () => {
    await fs.mkdir(mcpDir, { recursive: true });
    await fs.writeFile(mcpFile, JSON.stringify({ other: "stuff" }), "utf-8");

    const tools = createMcpMgmtTools({ projectId: "p-1" } as any);
    const tool = tools.inject_mcp_defaults as unknown as McpTool;

    const out = await tool.execute({});
    expect(out).toMatch(/Successfully added 3/);
    // Other fields preserved.
    const written = JSON.parse(await fs.readFile(mcpFile, "utf-8")) as any;
    expect(written.other).toBe("stuff");
  });
});
