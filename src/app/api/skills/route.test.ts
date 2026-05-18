/**
 * Tests for /api/skills — list bundled skills + mark installed status
 * for a project, install bundled skill into project.
 *
 * Pinned invariants:
 *   - GET without projectId: list with `installed: false` for ALL skills.
 *   - GET with projectId: cross-references installed skill names from the
 *     project's metadata, returning each bundled skill with `installed`
 *     flag set correctly (case-insensitive match).
 *   - GET returns 500 if loadProjectSkillsMetadata throws.
 *   - POST requires both projectId AND skillName (400 otherwise).
 *   - POST 400 on invalid JSON.
 *   - POST forwards to installBundledSkill; maps `{success: false, code}`
 *     to the correct status code.
 *   - POST 201 on success.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/storage/project-store", () => ({
  loadProjectSkillsMetadata: vi.fn(),
}));

vi.mock("@/lib/storage/bundled-skills-store", () => ({
  listBundledSkills: vi.fn(),
  installBundledSkill: vi.fn(),
}));

import { GET, POST } from "./route";
import { loadProjectSkillsMetadata } from "@/lib/storage/project-store";
import {
  installBundledSkill,
  listBundledSkills,
} from "@/lib/storage/bundled-skills-store";

const mockedLoad = vi.mocked(loadProjectSkillsMetadata);
const mockedList = vi.mocked(listBundledSkills);
const mockedInstall = vi.mocked(installBundledSkill);

beforeEach(() => {
  vi.clearAllMocks();
  mockedList.mockResolvedValue([
    { name: "alpha", description: "Alpha" },
    { name: "beta", description: "Beta" },
    { name: "gamma", description: "Gamma" },
  ] as any);
});

function buildGet(query = ""): NextRequest {
  return new NextRequest(`http://localhost:3000/api/skills${query}`);
}

function buildPost(body: unknown, raw = false): NextRequest {
  return new NextRequest("http://localhost:3000/api/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

describe("GET /api/skills — no projectId", () => {
  it("returns bundled skills with installed=false for ALL", async () => {
    const res = await GET(buildGet());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ name: string; installed: boolean }>;
    expect(body).toHaveLength(3);
    expect(body.every((s) => s.installed === false)).toBe(true);
    // Skip calling project-store when no projectId provided.
    expect(mockedLoad).not.toHaveBeenCalled();
  });
});

describe("GET /api/skills?projectId=... — installed-status crossref", () => {
  it("marks `installed: true` for skills present in the project (case-insensitive)", async () => {
    mockedLoad.mockResolvedValue([
      { name: "Alpha" } as any, // mixed case — comparison is case-insensitive
      { name: "gamma" } as any,
    ]);
    const res = await GET(buildGet("?projectId=p-1"));
    const body = (await res.json()) as Array<{ name: string; installed: boolean }>;
    const map = new Map(body.map((s) => [s.name, s.installed]));
    expect(map.get("alpha")).toBe(true);
    expect(map.get("beta")).toBe(false);
    expect(map.get("gamma")).toBe(true);
  });

  it("returns 500 when loadProjectSkillsMetadata throws", async () => {
    mockedLoad.mockRejectedValue(new Error("project missing"));
    const res = await GET(buildGet("?projectId=p-broken"));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/skills — install bundled", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await POST(buildPost("not-json", true));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid JSON/i);
  });

  it("returns 400 when projectId is missing", async () => {
    const res = await POST(buildPost({ skillName: "alpha" }));
    expect(res.status).toBe(400);
    expect(mockedInstall).not.toHaveBeenCalled();
  });

  it("returns 400 when skillName is missing", async () => {
    const res = await POST(buildPost({ projectId: "p-1" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when both fields are whitespace-only", async () => {
    const res = await POST(buildPost({ projectId: "   ", skillName: "  " }));
    expect(res.status).toBe(400);
  });

  it("forwards to installBundledSkill and returns 201 on success", async () => {
    mockedInstall.mockResolvedValue({
      success: true,
      targetDir: "/abs/skills/alpha",
    });

    const res = await POST(buildPost({ projectId: "p-1", skillName: "alpha" }));
    expect(res.status).toBe(201);
    expect(mockedInstall).toHaveBeenCalledWith("p-1", "alpha");

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.installedSkill).toBe("alpha");
    expect(body.targetDir).toBe("/abs/skills/alpha");
  });

  it("normalizes the installed skill name (lowercase + trim)", async () => {
    mockedInstall.mockResolvedValue({ success: true, targetDir: "/abs" });
    const res = await POST(buildPost({ projectId: "p-1", skillName: "  ALPHA  " }));
    const body = await res.json();
    expect(body.installedSkill).toBe("alpha");
  });

  it("maps install error to its captured status code (404, 409, 500, etc.)", async () => {
    mockedInstall.mockResolvedValue({
      success: false,
      error: "Skill 'x' already installed",
      code: 409,
    });
    const res = await POST(buildPost({ projectId: "p-1", skillName: "alpha" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already installed/i);
  });
});
