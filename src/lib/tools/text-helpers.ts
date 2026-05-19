/**
 * Pure utility functions extracted from `tool.ts` as part of the decompose
 * effort tracked in `CLAUDE.md` §8 "File-Size Discipline".
 *
 * These five helpers have no dependencies on `AgentContext`, the tool runtime,
 * file I/O, or any agent state — they're string-in / string-out. Each was a
 * private function in `tool.ts` that we lift to its own module so it can be:
 *
 *   1. Unit-tested in isolation (the parent `tool.ts` sits at ~5% coverage;
 *      these helpers each have known, well-defined behavior worth pinning).
 *   2. Reused by future tool modules without growing `tool.ts` past its
 *      1993-line mark (CLAUDE.md soft cap is 800).
 *
 * Naming: `text-helpers` rather than `utils` because that name lights up
 * grep when a contributor is looking for "where do these helpers live."
 * Avoid `utils.ts` — Orchestra already has one at `lib/utils.ts` and we
 * don't want to muddy the namespace.
 */
import path from "path";

/**
 * Infer a Prism / Shiki language identifier from a file's extension. Used by
 * the file-read and skill-loader tools to render code blocks with proper
 * syntax highlighting in the chat surface.
 *
 * Returns `"text"` for anything unrecognized — the chat renderer treats
 * `text` as plain content, which is the correct fallback (no highlighting,
 * no escape-character interpretation).
 */
export function inferLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".md":
      return "markdown";
    case ".json":
      return "json";
    case ".ts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
      return "javascript";
    case ".jsx":
      return "jsx";
    case ".py":
      return "python";
    case ".sh":
      return "bash";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".sql":
      return "sql";
    default:
      return "text";
  }
}

/**
 * Convert a user-supplied project name (or candidate id) into a slug safe
 * for use as a directory name and URL fragment.
 *
 * Rules:
 *   - lowercase the input
 *   - collapse runs of non-alphanumeric characters into single hyphens
 *   - trim leading/trailing hyphens
 *   - if the result is empty (e.g., input was only punctuation or whitespace),
 *     return a fresh 8-char UUID slice so the caller still gets a usable id
 *
 * The empty-input fallback is intentional: refusing to slugify would force
 * every caller to handle the null case, which historically led to "empty
 * project id" bugs (a precursor to PM #19). This function never returns
 * an empty string.
 */
export function slugifyProjectId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || crypto.randomUUID().slice(0, 8)
  );
}

/**
 * Normalize the *target* (right-hand side) of a Markdown link to a relative
 * filesystem path, or return `null` if the target isn't a local file
 * reference. Used by the skill loader to determine which files are linked
 * from a `SKILL.md` and must therefore be auto-loaded into the agent's
 * context.
 *
 * Rejects:
 *   - URLs (`http://`, `https://`)
 *   - mailto links
 *   - in-page anchors (`#section`)
 *   - empty / whitespace-only targets
 *
 * Strips:
 *   - surrounding angle brackets (`<file.md>` → `file.md`)
 *   - alt-text and title attributes after the target
 *   - URL fragments and query strings (`file.md#sec?v=1` → `file.md`)
 */
export function normalizeLocalMarkdownLinkTarget(rawTarget: string): string | null {
  const trimmed = rawTarget.trim();
  if (!trimmed) return null;

  let target = trimmed;
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1).trim();
  }

  const spaceQuoteIdx = target.search(/\s+["']/);
  if (spaceQuoteIdx >= 0) {
    target = target.slice(0, spaceQuoteIdx).trim();
  }

  const lower = target.toLowerCase();
  if (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("#")
  ) {
    return null;
  }

  const cleaned = target.split("#")[0].split("?")[0].trim();
  return cleaned || null;
}

/**
 * Parse a Markdown blob and return every UNIQUE local-file link target it
 * contains. Used by `parseRequiredSkillResourceLinks` below; lifted out as
 * a separate function so the de-duplication logic is testable in isolation.
 *
 * Treats both regular `[text](path)` and image `![alt](path)` syntaxes as
 * link references — for the skill-loader use-case, an image dependency is
 * just as important to surface as a text-link dependency.
 */
export function parseLocalMarkdownLinks(markdown: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const regex = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdown)) !== null) {
    const cleaned = normalizeLocalMarkdownLinkTarget(match[1] ?? "");
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
  }

  return result;
}

/**
 * Identify the local-file dependencies of a `SKILL.md` body. Currently the
 * implementation is `parseLocalMarkdownLinks` verbatim — every local link in
 * a SKILL.md is considered required context (no opt-in / opt-out marker).
 *
 * Kept as a separate function (rather than inlined as
 * `parseLocalMarkdownLinks(skillBody)`) so the contract is greppable: when
 * we decide to introduce a different policy ("only links inside
 * `## Required` sections", or "skip links with a `// optional` comment"),
 * the change lands here and the SKILL.md authoring story stays clean.
 */
export function parseRequiredSkillResourceLinks(markdown: string): string[] {
  return parseLocalMarkdownLinks(markdown);
}
