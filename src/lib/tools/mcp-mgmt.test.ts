/**
 * Tests for `createMcpMgmtTools` — the `inject_mcp_defaults` tool that
 * adds Sequential Thinking, GitHub, and SQLite MCP servers to a project's
 * mcp-servers.json on demand.
 *
 * Pinned invariants:
 *   - When no projectId is in context, return a clear error string —
 *     never crash the tool loop.
 *   - Read existing config when present, write fresh `{mcpServers: {}}`
 *     when the file is MISSING.
 *   - When the file EXISTS but cannot be merged into (invalid JSON, a
 *     top-level array/scalar, a non-object `mcpServers`), copy it aside to a
 *     `.corrupt-<stamp>` sibling and REFUSE — never overwrite it, never report
 *     success for a write that did not happen (PM #126). This replaced an
 *     earlier "treats it as empty" contract that destroyed real configs.
 *   - Unknown top-level keys in an otherwise-valid file survive the merge.
 *   - Idempotent: re-running on a project that already has the defaults
 *     reports "already configured" and does NOT rewrite the file
 *     (verified via mtime comparison).
 *   - Every default carries the expected command + args (typo-protection).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

// `project-mcp` (which owns the loose reader + quarantine helper) imports its
// path helpers from `project-store` too, so this mock covers both modules.
vi.mock("@/lib/storage/project-store", () => ({
  getProjectMcpServersPath: vi.fn(),
  getProjectMcpDir: vi.fn(),
  ensureDir: vi.fn(async () => {}),
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

/** Names of the quarantine copies sitting next to the servers file. */
async function corruptSiblings(): Promise<string[]> {
  const entries = await fs.readdir(mcpDir);
  return entries.filter((f) => f.includes(".corrupt-")).sort();
}

async function plant(content: string): Promise<void> {
  await fs.mkdir(mcpDir, { recursive: true });
  await fs.writeFile(mcpFile, content, "utf-8");
}

function injectTool(): McpTool {
  return createMcpMgmtTools({ projectId: "p-1" } as any)
    .inject_mcp_defaults as unknown as McpTool;
}

/**
 * PM #126. The previous contract here was "malformed → treat as empty", which
 * meant a trailing comma in a hand-edited config caused this tool to replace
 * every configured server with three defaults and report "Successfully added
 * 3". Non-negotiable #26 (copy aside before overwriting anything in `data/`)
 * and the tool-honesty rule both say otherwise: quarantine, then refuse.
 */
describe("inject_mcp_defaults — unmergeable config is quarantined, never overwritten", () => {
  const unmergeable: Array<[string, string, RegExp]> = [
    ["invalid JSON (a trailing comma / truncated file)", "{ broken JSON", /invalid JSON/i],
    ["a valid-JSON top-level array", "[1,2,3]", /top-level value is an array/i],
    ["a valid-JSON top-level scalar", '"just a string"', /top-level value is a string/i],
    ["a null document", "null", /top-level value is (a )?null/i],
    [
      "an `mcpServers` key that is not an object",
      JSON.stringify({ mcpServers: ["sequential-thinking"] }),
      /`mcpServers` is present but is not a JSON object/i,
    ],
  ];

  for (const [label, content, reasonPattern] of unmergeable) {
    it(`refuses and preserves the original bytes: ${label}`, async () => {
      await plant(content);

      const out = await injectTool().execute({});

      // 1. The tool reports failure — it must never claim a write that did not land.
      expect(out).toMatch(/^Error:/);
      expect(out).toMatch(/refusing to overwrite/i);
      expect(out).toMatch(reasonPattern);
      expect(out).not.toMatch(/Successfully added/);

      // 2. The original file is byte-identical.
      expect(await fs.readFile(mcpFile, "utf-8")).toBe(content);

      // 3. A copy was taken (non-negotiable #26), and the message names it.
      const backups = await corruptSiblings();
      expect(backups).toHaveLength(1);
      expect(await fs.readFile(path.join(mcpDir, backups[0]), "utf-8")).toBe(content);
      expect(out).toContain(backups[0]);
    });
  }

  it("emits a greppable structured warn line naming the backup (PM #30)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await plant("{ broken JSON");

    await injectTool().execute({});

    const line = warn.mock.calls.map((c) => String(c[0])).find((c) =>
      c.includes("mcp_servers_file_malformed")
    );
    expect(line).toBeDefined();
    const payload = JSON.parse(line!.slice(line!.indexOf("{")));
    expect(payload).toMatchObject({
      projectId: "p-1",
      filePath: mcpFile,
      sizeBytes: Buffer.byteLength("{ broken JSON", "utf-8"),
    });
    expect(payload.reason).toMatch(/invalid JSON/i);
    expect(payload.backupPath).toContain(".corrupt-");
    warn.mockRestore();
  });

  it("a second corruption never clobbers the first backup", async () => {
    await plant("{ first broken");
    await injectTool().execute({});
    await plant("{ second broken");
    await injectTool().execute({});

    const backups = await corruptSiblings();
    expect(backups).toHaveLength(2);
    const contents = await Promise.all(
      backups.map((b) => fs.readFile(path.join(mcpDir, b), "utf-8"))
    );
    expect(contents.sort()).toEqual(["{ first broken", "{ second broken"]);
  });

  it("leaves no backup behind when the file is simply missing", async () => {
    const out = await injectTool().execute({});
    expect(out).toMatch(/Successfully added 3/);
    expect(await corruptSiblings()).toEqual([]);
  });
});

describe("inject_mcp_defaults — defensive parsing", () => {
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

/**
 * PM #127 audit — tool honesty. A legacy `{servers:[...]}` file survives the
 * merge, but the loader prefers `mcpServers`, so those entries stop being
 * active. Reporting a bare "Successfully added 3" while the operator's own
 * servers go dark is the defect class this repo already has a rule about.
 */
describe("inject_mcp_defaults — a stranded legacy `servers` array is named", () => {
  it("warns that a legacy servers array is not loaded", async () => {
    await plant(
      JSON.stringify({
        servers: [
          { id: "s1", transport: "stdio", command: "node" },
          { id: "s2", transport: "stdio", command: "node" },
        ],
      })
    );

    const out = await injectTool().execute({});

    expect(out).toMatch(/Successfully added 3/);
    expect(out).toMatch(/legacy "servers" array with 2 entries/i);
    expect(out).toMatch(/IGNORES that array/i);

    // The legacy array itself is still preserved on disk — the tool reports,
    // it does not silently migrate or delete.
    const written = JSON.parse(await fs.readFile(mcpFile, "utf-8"));
    expect(written.servers).toHaveLength(2);
  });

  it("says nothing about legacy entries when there are none", async () => {
    const out = await injectTool().execute({});
    expect(out).toMatch(/Successfully added 3/);
    expect(out).not.toMatch(/legacy/i);
  });
});
