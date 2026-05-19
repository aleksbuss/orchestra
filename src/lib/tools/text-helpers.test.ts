/**
 * Tests for the pure utility helpers extracted from `tool.ts`.
 *
 * These functions were previously private and reached only through
 * end-to-end agent flows where they were responsible for a 5%-coverage
 * file. Lifting them out + writing focused tests is the first concrete
 * step in the CLAUDE.md §8 file-size-discipline cleanup. The functions
 * themselves are unchanged; this file pins their existing behavior so a
 * future refactor or replacement has a regression net.
 */
import { describe, it, expect } from "vitest";
import {
  inferLanguageFromPath,
  normalizeLocalMarkdownLinkTarget,
  parseLocalMarkdownLinks,
  parseRequiredSkillResourceLinks,
  slugifyProjectId,
} from "./text-helpers";

describe("inferLanguageFromPath", () => {
  it("recognises every supported extension by lowercase mapping", () => {
    const cases: Array<[string, string]> = [
      ["foo.md", "markdown"],
      ["readme.MD", "markdown"], // case-insensitive
      ["config.json", "json"],
      ["main.ts", "typescript"],
      ["component.tsx", "tsx"],
      ["index.js", "javascript"],
      ["view.jsx", "jsx"],
      ["script.py", "python"],
      ["deploy.sh", "bash"],
      ["compose.yml", "yaml"],
      ["compose.yaml", "yaml"],
      ["schema.sql", "sql"],
    ];
    for (const [filePath, expected] of cases) {
      expect(inferLanguageFromPath(filePath), `path=${filePath}`).toBe(expected);
    }
  });

  it("returns 'text' for unrecognized extensions (safe default — no markdown injection)", () => {
    expect(inferLanguageFromPath("notes.txt")).toBe("text");
    expect(inferLanguageFromPath("data.csv")).toBe("text");
    expect(inferLanguageFromPath("binary.bin")).toBe("text");
    expect(inferLanguageFromPath("noext")).toBe("text");
  });

  it("uses only the basename's extension — directory parts are ignored", () => {
    expect(inferLanguageFromPath("/path/to/file.ts")).toBe("typescript");
    expect(inferLanguageFromPath("a/b.json/c.py")).toBe("python");
  });
});

describe("slugifyProjectId", () => {
  it("lowercases + replaces non-alphanumeric runs with single hyphen", () => {
    expect(slugifyProjectId("My Cool Project")).toBe("my-cool-project");
    expect(slugifyProjectId("foo___bar")).toBe("foo-bar");
    expect(slugifyProjectId("A&B&C")).toBe("a-b-c");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugifyProjectId("  hello  ")).toBe("hello");
    expect(slugifyProjectId("---foo---")).toBe("foo");
    expect(slugifyProjectId("!!!proj!!!")).toBe("proj");
  });

  it("never returns an empty string — falls back to a UUID slice (PM #19 precursor)", () => {
    // The historical "empty project id" bug class motivated this fallback.
    // If a user submits only whitespace or only punctuation, we still
    // produce a usable id rather than failing downstream.
    const fromBlank = slugifyProjectId("   ");
    expect(fromBlank).not.toBe("");
    expect(fromBlank.length).toBe(8);
    expect(/^[0-9a-f]{8}$/.test(fromBlank)).toBe(true);

    const fromPunct = slugifyProjectId("!@#$%");
    expect(fromPunct).not.toBe("");
    expect(/^[0-9a-f]{8}$/.test(fromPunct)).toBe(true);
  });

  it("preserves numeric characters", () => {
    expect(slugifyProjectId("Sprint 42")).toBe("sprint-42");
    expect(slugifyProjectId("v1.2.3")).toBe("v1-2-3");
  });

  it("handles Unicode by stripping it (ASCII-only output)", () => {
    // The slug is used as a directory name + URL fragment; ASCII keeps
    // both portable across filesystems and URL-safe.
    expect(slugifyProjectId("Проект Tëst")).toMatch(/^t-st$|^[0-9a-f]{8}$/);
  });
});

describe("normalizeLocalMarkdownLinkTarget", () => {
  it("returns null for empty / whitespace-only input", () => {
    expect(normalizeLocalMarkdownLinkTarget("")).toBeNull();
    expect(normalizeLocalMarkdownLinkTarget("   ")).toBeNull();
    expect(normalizeLocalMarkdownLinkTarget("\t\n")).toBeNull();
  });

  it("rejects external URL schemes", () => {
    expect(normalizeLocalMarkdownLinkTarget("http://example.com")).toBeNull();
    expect(normalizeLocalMarkdownLinkTarget("https://example.com")).toBeNull();
    expect(normalizeLocalMarkdownLinkTarget("HTTPS://EXAMPLE.COM")).toBeNull();
    expect(normalizeLocalMarkdownLinkTarget("mailto:user@example.com")).toBeNull();
  });

  it("rejects pure in-page anchors", () => {
    expect(normalizeLocalMarkdownLinkTarget("#section")).toBeNull();
    expect(normalizeLocalMarkdownLinkTarget("#")).toBeNull();
  });

  it("strips surrounding angle brackets", () => {
    expect(normalizeLocalMarkdownLinkTarget("<file.md>")).toBe("file.md");
    expect(normalizeLocalMarkdownLinkTarget("<  ./docs/x.md  >")).toBe("./docs/x.md");
  });

  it("strips alt-text / title attribute after the target", () => {
    expect(normalizeLocalMarkdownLinkTarget(`file.md "Title"`)).toBe("file.md");
    expect(normalizeLocalMarkdownLinkTarget(`./x.md 'My Doc'`)).toBe("./x.md");
  });

  it("strips URL fragments and query strings from local paths", () => {
    expect(normalizeLocalMarkdownLinkTarget("file.md#section")).toBe("file.md");
    expect(normalizeLocalMarkdownLinkTarget("file.md?v=1")).toBe("file.md");
    expect(normalizeLocalMarkdownLinkTarget("file.md#sec?v=1")).toBe("file.md");
  });

  it("preserves relative path prefixes (./, ../)", () => {
    expect(normalizeLocalMarkdownLinkTarget("./docs/x.md")).toBe("./docs/x.md");
    expect(normalizeLocalMarkdownLinkTarget("../shared.md")).toBe("../shared.md");
  });
});

describe("parseLocalMarkdownLinks", () => {
  it("extracts unique local links from regular and image syntax", () => {
    const md = `
      See [docs](./docs/index.md) and ![diagram](./diagram.png).
      Also [README](README.md).
    `;
    const result = parseLocalMarkdownLinks(md);
    expect(result.sort()).toEqual(["./diagram.png", "./docs/index.md", "README.md"]);
  });

  it("deduplicates links that appear multiple times", () => {
    const md = `[a](./x.md) [b](./x.md) [c](./x.md)`;
    expect(parseLocalMarkdownLinks(md)).toEqual(["./x.md"]);
  });

  it("skips external URLs", () => {
    const md = `[ext](https://example.com) [local](./x.md) [also](http://foo)`;
    expect(parseLocalMarkdownLinks(md)).toEqual(["./x.md"]);
  });

  it("skips in-page anchors", () => {
    const md = `[section](#foo) [page](./bar.md)`;
    expect(parseLocalMarkdownLinks(md)).toEqual(["./bar.md"]);
  });

  it("returns empty array for markdown with no links", () => {
    expect(parseLocalMarkdownLinks("just plain text")).toEqual([]);
    expect(parseLocalMarkdownLinks("")).toEqual([]);
  });

  it("preserves first-seen order in the result", () => {
    const md = `[c](./c.md) [a](./a.md) [b](./b.md)`;
    expect(parseLocalMarkdownLinks(md)).toEqual(["./c.md", "./a.md", "./b.md"]);
  });
});

describe("parseRequiredSkillResourceLinks", () => {
  // Currently delegates to parseLocalMarkdownLinks (every local link in a
  // SKILL.md is treated as required). Pinned separately because the
  // contract may diverge — a future "// optional" marker or
  // "## Required" section gate would change this function but NOT
  // parseLocalMarkdownLinks.
  it("returns the same shape as parseLocalMarkdownLinks for a typical SKILL.md", () => {
    const skillMd = `
      ---
      name: my-skill
      ---
      Refer to [setup](./setup.md) and [examples](examples/).
      ![icon](icon.png)
    `;
    expect(parseRequiredSkillResourceLinks(skillMd).sort()).toEqual(
      parseLocalMarkdownLinks(skillMd).sort()
    );
  });

  it("returns empty array for a SKILL.md with no local resources", () => {
    expect(parseRequiredSkillResourceLinks("Just an inline skill.")).toEqual([]);
  });
});
