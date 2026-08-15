import fs from "fs/promises";
import path from "path";
import type { AgentContext } from "@/lib/agent/types";
import { getProjectMetaRoot } from "@/lib/storage/project-store";
import { dataPath } from "@/lib/storage/data-dir";

/**
 * Context-aware path resolution shared by the agent tool families
 * (file tools, code execution, Telegram uploads, project navigation).
 * Extracted verbatim from `tool.ts` as part of the §10 decomposition —
 * behavior is contract: several tools rely on the exact candidate order
 * of `resolveReadableFilePath` and the sandbox fallback of
 * `resolveContextCwd`.
 */

/**
 * The base directory of the current agent context — the content root the
 * agent is working in, before `currentPath` is applied.
 *
 * `context.workDir` is the project's content root, resolved once per turn by
 * the agent context builder (`getProjectContentRoot`), so linked projects get
 * their real repository here. When it is absent — a context built by an older
 * call site, or a test — we fall back to the Orchestra-owned sandbox rather
 * than doing a synchronous guess at the user's repo: no root is better than
 * the wrong root.
 *
 * PM #105 — this is THE resolver. Any tool that reports where the agent is
 * must call it, not re-derive the answer; a report that disagrees with the
 * acting path is invisible to the model and it will act on the report.
 */
export function resolveContextBaseDir(context: AgentContext): string {
  return context.workDir?.trim() || getProjectMetaRoot(context.projectId);
}

/**
 * Resolve the effective working directory for the current agent context:
 * the base directory with `currentPath` applied. A `currentPath` that
 * escapes the base directory resolves back to the base (sandbox posture).
 */
export function resolveContextCwd(context: AgentContext): string {
  const baseDir = resolveContextBaseDir(context);
  const rawCurrentPath = context.currentPath?.trim();
  if (!rawCurrentPath) {
    return baseDir;
  }

  // currentPath is expected to be project-relative; normalize absolute-like inputs ("/foo")
  // to stay inside the active project work directory.
  const normalized = path.normalize(rawCurrentPath).replace(/^[/\\]+/, "");
  const resolved = path.resolve(baseDir, normalized);

  if (
    resolved === baseDir ||
    resolved.startsWith(baseDir + path.sep)
  ) {
    return resolved;
  }

  return baseDir;
}

/**
 * Resolve a model-supplied output path: absolute paths pass through,
 * relative paths resolve against the context working directory.
 * Throws on an empty path.
 */
export function resolveOutgoingFilePath(
  context: AgentContext,
  rawPath: string
): string {
  const value = rawPath.trim();
  if (!value) {
    throw new Error("file_path is required");
  }
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }

  const cwd = resolveContextCwd(context);
  return path.resolve(cwd, value);
}

async function isExistingRegularFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    const normalized = path.normalize(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * Resolve a model-supplied path for READING: fans out over candidate
 * locations (context cwd, accidental slashless-absolute Unix paths,
 * the chat's `data/chat-files/<chatId>/` uploads) and returns the first
 * candidate that exists as a regular file, or the first candidate overall
 * so the caller's `fs.stat` produces a precise error.
 */
export async function resolveReadableFilePath(
  context: AgentContext,
  rawPath: string
): Promise<string> {
  const value = rawPath.trim();
  if (!value) {
    throw new Error("file_path is required");
  }

  const normalizedInput = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const candidates: string[] = [resolveOutgoingFilePath(context, value)];

  // Heuristic for accidental Unix absolute paths without a leading slash,
  // e.g. "Users/name/file.pdf" instead of "/Users/name/file.pdf".
  if (!path.isAbsolute(value) && /^(Users|home|var|tmp)\//.test(normalizedInput)) {
    candidates.push(path.resolve(path.sep, normalizedInput));
  }

  if (path.isAbsolute(value)) {
    candidates.push(path.resolve(value));
  }

  const chatId = context.chatId?.trim();
  if (chatId) {
    const chatFilesDir = dataPath("chat-files", chatId);
    const sanitized = value.replace(/^\.\/+/, "");

    if (!path.isAbsolute(value) && !sanitized.includes("/") && !sanitized.includes("\\")) {
      candidates.push(path.join(chatFilesDir, sanitized));
    }

    if (!path.isAbsolute(value)) {
      if (normalizedInput.startsWith("chat-files/")) {
        candidates.push(dataPath(normalizedInput));
      } else if (normalizedInput.startsWith("data/chat-files/")) {
        candidates.push(path.resolve(process.cwd(), normalizedInput));
      }
    }
  }

  const uniqueCandidates = uniquePaths(candidates);
  for (const candidate of uniqueCandidates) {
    if (await isExistingRegularFile(candidate)) {
      return candidate;
    }
  }

  return uniqueCandidates[0];
}

/**
 * Normalize a context `currentPath` for tool OUTPUT: strips leading
 * separators, converts backslashes, and maps "."/empty to "".
 */
export function normalizeContextPathForOutput(
  rawPath: string | null | undefined
): string {
  const raw = rawPath?.trim();
  if (!raw) {
    return "";
  }
  const normalized = path.normalize(raw).replace(/^[/\\]+/, "").replace(/\\/g, "/");
  return normalized === "." ? "" : normalized;
}
