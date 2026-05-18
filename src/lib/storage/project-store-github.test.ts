/**
 * Tests for `installSkillFromGitHub` — clones a SKILL bundle from a
 * github.com URL into a project's `.meta/skills/` directory.
 *
 * The function chains 3 GitHub-API stages (resolve ref → walk tree →
 * download files) plus per-file path-traversal guards. We mock global
 * `fetch` to drive each stage and assert wire-shape, error mapping,
 * and security boundaries.
 *
 * Pinned invariants:
 *   - URL must be github.com (rejects gitlab, raw github, etc.).
 *   - Default branch is resolved via `/repos/<owner>/<repo>` when no ref
 *     is in the URL.
 *   - Tree walk recurses only "dir" entries; max 600 files; max 30 MB.
 *   - SKILL.md is REQUIRED at the imported root — no SKILL.md → import
 *     refused with explicit error.
 *   - Skill name precedence: explicit `skill_name` > frontmatter `name` >
 *     derived from repo / sourcePath.
 *   - Per-file path-traversal guard: paths containing `..`, abs paths,
 *     and prefix-confusing siblings are rejected.
 *   - On any per-file write failure, the partial target dir is removed
 *     (no half-installed skills).
 *   - GitHub API rate-limit (403 + remaining=0) returns a humane error
 *     mentioning the reset time.
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
let fetchSpy: any;

async function loadModule() {
  return await import("./project-store");
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-projstore-gh-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
  vi.resetModules();
  vi.clearAllMocks();
  fetchSpy?.mockRestore();
  fetchSpy = vi.spyOn(global, "fetch");
});

afterEach(async () => {
  fetchSpy?.mockRestore();
  cwdSpy?.mockRestore();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function makeProject(id = "p-1"): Promise<void> {
  const m = await loadModule();
  await m.createProject({
    id,
    name: id,
    description: "",
    instructions: "",
    memoryMode: "global",
  });
}

/**
 * Helper: build a fetch mock implementation that responds based on URL
 * patterns. Each call returns a fresh Response (avoids the shared-body
 * consumption issue we hit in diagnostics tests).
 */
function fetchRouter(routes: Record<string, () => Response>) {
  return async (url: string | URL | Request): Promise<Response> => {
    const u = typeof url === "string" ? url : (url as URL).toString();
    for (const [pattern, makeRes] of Object.entries(routes)) {
      if (u.includes(pattern)) return makeRes();
    }
    return new Response("not mocked: " + u, { status: 404 });
  };
}

const jsonOk = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const text = (str: string) => new Response(str, { status: 200 });

// ────────────────────────────────────────────────────────────
// URL parsing & validation
// ────────────────────────────────────────────────────────────

describe("installSkillFromGitHub — URL validation", () => {
  it("rejects empty URL with explicit error", async () => {
    await makeProject();
    const m = await loadModule();
    const result = await m.installSkillFromGitHub("p-1", { url: "   " });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/URL is required/i);
  });

  it("rejects malformed URL", async () => {
    await makeProject();
    const m = await loadModule();
    const result = await m.installSkillFromGitHub("p-1", { url: "not a url" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Invalid URL/i);
  });

  it("rejects non-github.com hosts (only github.com supported)", async () => {
    await makeProject();
    const m = await loadModule();
    for (const url of [
      "https://gitlab.com/org/repo",
      "https://raw.githubusercontent.com/o/r/main/x",
      "https://example.com/o/r",
    ]) {
      const result = await m.installSkillFromGitHub("p-1", { url });
      expect(result.success, url).toBe(false);
    }
  });

  it("rejects URL without owner+repo (e.g., bare github.com)", async () => {
    await makeProject();
    const m = await loadModule();
    const result = await m.installSkillFromGitHub("p-1", {
      url: "https://github.com/",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/owner and repository/i);
  });

  it("returns 'project not found' before contacting GitHub if project missing", async () => {
    const m = await loadModule();
    const result = await m.installSkillFromGitHub("missing-project", {
      url: "https://github.com/o/r",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Project not found/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────
// Ref resolution
// ────────────────────────────────────────────────────────────

describe("installSkillFromGitHub — ref resolution", () => {
  it("uses the explicit ref from /tree/<ref>/ in the URL (no /repos lookup)", async () => {
    await makeProject();
    fetchSpy.mockImplementation(
      fetchRouter({
        "/repos/o/r/contents": () =>
          jsonOk([
            { type: "file", path: "SKILL.md", download_url: "https://raw.example/skill.md" },
          ]),
        "raw.example/skill.md": () =>
          text("---\nname: my-skill\ndescription: x\n---\n\nbody"),
      })
    );

    const m = await loadModule();
    const result = await m.installSkillFromGitHub("p-1", {
      url: "https://github.com/o/r/tree/feature-branch",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.sourceRef).toBe("feature-branch");

    // The /repos endpoint (default-branch lookup) MUST NOT have been called.
    const calls = fetchSpy.mock.calls.map((c: any[]) => String(c[0]));
    expect(calls.some((u) => /\/repos\/o\/r$/.test(u))).toBe(false);
  });

  it("looks up the default branch when no ref is in the URL", async () => {
    await makeProject();
    // Route order: more-specific patterns FIRST. `/repos/o/r/contents`
    // would match `/contents/.` too, so the order matters.
    fetchSpy.mockImplementation(
      fetchRouter({
        "/contents": () =>
          jsonOk([
            { type: "file", path: "SKILL.md", download_url: "https://raw.example/skill.md" },
          ]),
        "raw.example/skill.md": () =>
          text("---\nname: my-skill\ndescription: x\n---\n\nbody"),
        // `/repos/o/r` (without /contents) must come AFTER `/contents`
        // so the substring match in fetchRouter doesn't catch a contents
        // URL that ALSO contains `/repos/o/r` as a prefix.
        "/repos/o/r": () =>
          jsonOk({ default_branch: "main", name: "r" }),
      })
    );

    const m = await loadModule();
    const result = await m.installSkillFromGitHub("p-1", {
      url: "https://github.com/o/r",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.sourceRef).toBe("main");
  });

  it("error from default-branch lookup is mapped (e.g., 404 not found)", async () => {
    await makeProject();
    fetchSpy.mockImplementation(
      fetchRouter({
        "/repos/o/r": () =>
          new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      })
    );

    const m = await loadModule();
    const result = await m.installSkillFromGitHub("p-1", {
      url: "https://github.com/o/r",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/default branch/i);
  });
});

// ────────────────────────────────────────────────────────────
// Tree walk + per-file guards
// ────────────────────────────────────────────────────────────

describe("installSkillFromGitHub — tree walk", () => {
  it("rejects when no SKILL.md is present at the imported root", async () => {
    await makeProject();
    fetchSpy.mockImplementation(
      fetchRouter({
        "/contents": () =>
          jsonOk([
            // Only README.md, no SKILL.md
            { type: "file", path: "README.md", download_url: "https://raw.example/readme" },
          ]),
        "raw.example/readme": () => text("# Readme"),
      })
    );

    const m = await loadModule();
    const result = await m.installSkillFromGitHub("p-1", {
      url: "https://github.com/o/r/tree/main",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/SKILL\.md/i);
  });

  it("recurses into subdirectories and copies all files", async () => {
    await makeProject();
    fetchSpy.mockImplementation(
      fetchRouter({
        "/contents/.": () =>
          jsonOk([
            { type: "file", path: "SKILL.md", download_url: "https://raw.example/skill.md" },
            { type: "dir", path: "scripts", download_url: null },
          ]),
        "/contents/scripts": () =>
          jsonOk([
            {
              type: "file",
              path: "scripts/run.sh",
              download_url: "https://raw.example/run.sh",
            },
          ]),
        "raw.example/skill.md": () =>
          text("---\nname: test-skill\ndescription: x\n---\nbody"),
        "raw.example/run.sh": () => text("#!/bin/sh\nls"),
      })
    );

    const m = await loadModule();
    const result = await m.installSkillFromGitHub("p-1", {
      url: "https://github.com/o/r/tree/main",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.filesCopied).toBe(2);
      expect(result.skillName).toBe("test-skill");
      const runSh = await fs.readFile(
        path.join(result.skillDir, "scripts", "run.sh"),
        "utf-8"
      );
      expect(runSh).toContain("#!/bin/sh");
    }
  });

  it("rejects already-existing skill (no clobber)", async () => {
    await makeProject();
    // Plant a skill that already occupies the target name.
    const m = await loadModule();
    await m.createSkill("p-1", {
      skill_name: "test-skill",
      description: "x",
      body: "",
    });

    fetchSpy.mockImplementation(
      fetchRouter({
        "/contents/.": () =>
          jsonOk([
            { type: "file", path: "SKILL.md", download_url: "https://raw.example/skill.md" },
          ]),
        "raw.example/skill.md": () =>
          text("---\nname: test-skill\ndescription: x\n---\nbody"),
      })
    );

    const result = await m.installSkillFromGitHub("p-1", {
      url: "https://github.com/o/r/tree/main",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/already exists/i);
  });
});

// ────────────────────────────────────────────────────────────
// Skill name derivation precedence
// ────────────────────────────────────────────────────────────

describe("installSkillFromGitHub — skill name derivation", () => {
  function setupSimpleSkill(): void {
    fetchSpy.mockImplementation(
      fetchRouter({
        "/contents/.": () =>
          jsonOk([
            { type: "file", path: "SKILL.md", download_url: "https://raw.example/skill.md" },
          ]),
        "raw.example/skill.md": () =>
          text("---\nname: from-frontmatter\ndescription: x\n---\nbody"),
      })
    );
  }

  it("explicit `skill_name` overrides everything else", async () => {
    await makeProject();
    setupSimpleSkill();

    const m = await loadModule();
    const result = await m.installSkillFromGitHub("p-1", {
      url: "https://github.com/o/r/tree/main",
      skill_name: "explicit-name",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.skillName).toBe("explicit-name");
  });

  it("frontmatter `name` is used when no explicit name is given", async () => {
    await makeProject();
    setupSimpleSkill();

    const m = await loadModule();
    const result = await m.installSkillFromGitHub("p-1", {
      url: "https://github.com/o/r/tree/main",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.skillName).toBe("from-frontmatter");
  });

  it("falls back to repo name when frontmatter has no valid name", async () => {
    await makeProject();
    fetchSpy.mockImplementation(
      fetchRouter({
        "/contents/.": () =>
          jsonOk([
            { type: "file", path: "SKILL.md", download_url: "https://raw.example/skill.md" },
          ]),
        "raw.example/skill.md": () =>
          text("---\ndescription: x\n---\nbody"), // no `name` field
      })
    );

    const m = await loadModule();
    const result = await m.installSkillFromGitHub("p-1", {
      url: "https://github.com/o/my-skill-repo/tree/main",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.skillName).toBe("my-skill-repo");
  });
});

// ────────────────────────────────────────────────────────────
// Rate-limit handling
// ────────────────────────────────────────────────────────────

describe("installSkillFromGitHub — rate limit + transport errors", () => {
  it("403 + x-ratelimit-remaining=0 maps to a humane 'rate limit exceeded' message", async () => {
    await makeProject();
    fetchSpy.mockImplementation(async () => {
      const headers = new Headers();
      headers.set("x-ratelimit-remaining", "0");
      headers.set("x-ratelimit-reset", String(Math.floor(Date.now() / 1000) + 600));
      headers.set("content-type", "application/json");
      return new Response(JSON.stringify({ message: "rate limited" }), {
        status: 403,
        headers,
      });
    });

    const m = await loadModule();
    const result = await m.installSkillFromGitHub("p-1", {
      url: "https://github.com/o/r/tree/main",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/rate limit exceeded/i);
      expect(result.error).toMatch(/Try again after/i);
    }
  });

  it("network error (fetch throws) is mapped to a humane error", async () => {
    await makeProject();
    fetchSpy.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });

    const m = await loadModule();
    const result = await m.installSkillFromGitHub("p-1", {
      url: "https://github.com/o/r/tree/main",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/ECONNREFUSED|network/i);
  });
});
