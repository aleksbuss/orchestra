import fs from "fs/promises";
import path from "path";
import type { AgentContext } from "@/lib/agent/types";
import { getWorkDir } from "@/lib/storage/project-store";
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
 * Resolve the effective working directory for the current agent context.
 * Prefers pre-resolved `context.workDir` when the agent context builder set
 * it (linked projects honor `absoluteRoot` here); falls back to the sync
 * `getWorkDir` for sandbox projects and pre-existing call sites that
 * haven't been migrated to populate `workDir` yet. A `currentPath` that
 * escapes the base directory resolves back to the base (sandbox posture).
 */
export function resolveContextCwd(context: AgentContext): string {
  const baseDir = context.workDir?.trim() || getWorkDir(context.projectId);
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
