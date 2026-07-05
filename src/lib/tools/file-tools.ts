import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "path";
import type { AgentContext } from "@/lib/agent/types";
import { verifyWrittenSource } from "@/lib/tools/post-write-verify";
import { recordFileWrite, largeFileRewriteHint } from "@/lib/tools/write-rewrite-budget";
import {
  checkSyntaxFailureStreak,
  recordSyntaxOutcome,
} from "@/lib/tools/write-failure-streak";
import { snapshotBeforeWrite } from "@/lib/storage/snapshots";
import { loadPdf } from "@/lib/memory/loaders/pdf-loader";
import { inferLanguageFromPath } from "@/lib/tools/text-helpers";
import {
  resolveOutgoingFilePath,
  resolveReadableFilePath,
} from "@/lib/tools/tool-paths";

/**
 * Local file tool family: read (text + PDF), write, targeted replace, copy.
 * Carries the PM #80 grounding signal (post-write syntax verify), the
 * PM #80/#83 cross-turn rewrite budget + failure-keyed streak breaker, and
 * pre-overwrite snapshots. Extracted verbatim from `tool.ts`
 * (§10 decomposition, PR 2).
 */

const TEXT_FILE_READ_MAX_CHARS = 30000;
const TEXT_FILE_WRITE_MAX_CHARS = 400000;
const PDF_FILE_READ_MAX_CHARS = 30000;

export function createFileTools(context: AgentContext): ToolSet {
  const tools: ToolSet = {};

  tools.read_text_file = tool({
    description:
      "Read a local UTF-8 text file (for example .txt, .md, .json, .csv, source code). Use this for file reading tasks instead of code_execution.",
    inputSchema: z.object({
      file_path: z
        .string()
        .describe("Absolute path, or path relative to current project cwd."),
      start_line: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("1-based line number to start reading from."),
      max_lines: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(300)
        .describe("Maximum number of lines to return."),
      max_chars: z
        .number()
        .int()
        .min(200)
        .max(TEXT_FILE_READ_MAX_CHARS)
        .default(12000)
        .describe("Maximum number of characters to return."),
    }),
    execute: async ({ file_path, start_line, max_lines, max_chars }) => {
      try {
        const resolvedPath = await resolveReadableFilePath(context, file_path);
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile()) {
          return {
            success: false,
            error: `Path is not a file: ${resolvedPath}`,
          };
        }

        const raw = await fs.readFile(resolvedPath, "utf-8");
        if (raw.includes("\u0000")) {
          return {
            success: false,
            error: `File appears to be binary and is not suitable for read_text_file: ${resolvedPath}`,
          };
        }

        const normalized = raw.replace(/\r\n/g, "\n");
        const lines = normalized.split("\n");
        const startIndex = Math.max(0, start_line - 1);
        const endIndex = Math.min(lines.length, startIndex + max_lines);
        const selected = lines.slice(startIndex, endIndex).join("\n");
        const truncatedByChars = selected.length > max_chars;
        const content = truncatedByChars
          ? `${selected.slice(0, max_chars)}\n\n[Truncated by max_chars]`
          : selected;
        const language = inferLanguageFromPath(resolvedPath);

        return {
          success: true,
          path: resolvedPath,
          size: stat.size,
          totalLines: lines.length,
          startLine: startIndex + 1,
          endLine: endIndex,
          truncated: truncatedByChars || endIndex < lines.length,
          language,
          content,
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to read text file.",
        };
      }
    },
  });

  tools.read_pdf_file = tool({
    description:
      "Extract text from a local PDF file. Use this for reading PDF contents without Python.",
    inputSchema: z.object({
      file_path: z
        .string()
        .describe("Absolute path, or path relative to current project cwd."),
      max_chars: z
        .number()
        .int()
        .min(200)
        .max(PDF_FILE_READ_MAX_CHARS)
        .default(15000)
        .describe("Maximum number of extracted text characters to return."),
    }),
    execute: async ({ file_path, max_chars }) => {
      try {
        const resolvedPath = await resolveReadableFilePath(context, file_path);
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile()) {
          return {
            success: false,
            error: `Path is not a file: ${resolvedPath}`,
          };
        }

        const parsed = await loadPdf(resolvedPath);
        const text = (parsed.text ?? "").trim();
        const truncated = text.length > max_chars;
        const content = truncated
          ? `${text.slice(0, max_chars)}\n\n[Truncated by max_chars]`
          : text;

        return {
          success: true,
          path: resolvedPath,
          size: stat.size,
          metadata: parsed.metadata,
          extractedChars: text.length,
          truncated,
          content,
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to read PDF file.",
        };
      }
    },
  });

  tools.write_text_file = tool({
    description:
      "Create or update a local UTF-8 text file. Use this for writing .md/.txt/.json/code files instead of code_execution.",
    inputSchema: z.object({
      file_path: z
        .string()
        .describe("Absolute path, or path relative to current project cwd."),
      content: z
        .string()
        .describe("Full UTF-8 text content to write."),
      overwrite: z
        .boolean()
        .default(true)
        .describe("Whether to overwrite existing file if it already exists."),
    }),
    execute: async ({ file_path, content, overwrite }) => {
      try {
        if (content.length > TEXT_FILE_WRITE_MAX_CHARS) {
          return {
            success: false,
            error: `Content too large (${content.length} chars). Max allowed is ${TEXT_FILE_WRITE_MAX_CHARS}.`,
          };
        }

        const resolvedPath = resolveOutgoingFilePath(context, file_path);
        let existed = false;
        let existedSize = 0;
        try {
          const before = await fs.stat(resolvedPath);
          if (!before.isFile()) {
            return {
              success: false,
              error: `Target exists and is not a regular file: ${resolvedPath}`,
            };
          }
          existed = true;
          existedSize = before.size;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") throw error;
        }

        if (existed && !overwrite) {
          return {
            success: false,
            error: `File already exists and overwrite=false: ${resolvedPath}`,
          };
        }

        // Failure-keyed cross-turn loop backstop (PM #83): if this file has
        // failed its post-write syntax check too many times in a row, refuse one
        // write so the model reads/verifies instead of re-mangling. Checked
        // before the count budget; the two gates run independently.
        const syntaxStreak = checkSyntaxFailureStreak(context.chatId, resolvedPath);
        if (syntaxStreak.action === "block") {
          return { success: false, error: syntaxStreak.message };
        }

        // Cross-turn rewrite-loop backstop (PM #80 follow-up): the per-turn loop
        // guard resets each turn and cannot see a file rewritten across many
        // "continue" turns. This caps rewrites of one file within a chat and
        // refuses the write (without executing it) once the cap is hit, forcing
        // a read/verify/ask instead of another blind full rewrite.
        const rewriteBudget = recordFileWrite(context.chatId, resolvedPath);
        if (rewriteBudget.action === "block") {
          return { success: false, error: rewriteBudget.message };
        }

        // Best-effort recovery snapshot of the previous content. snapshotBeforeWrite
        // is internally try/catch and returns null on any error — the write must
        // never be blocked by a snapshot bug. See `src/lib/storage/snapshots.ts`.
        if (existed) {
          await snapshotBeforeWrite({
            projectId: context.projectId ?? "none",
            chatId: context.chatId,
            filePath: resolvedPath,
            reason: "write_text_file overwrite",
          });
        }

        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        await fs.writeFile(resolvedPath, content, "utf-8");
        const after = await fs.stat(resolvedPath);

        // Grounding signal (PM #80): a syntax-only check on the content just
        // written. `{ success: true, bytes }` alone tells the model the WRITE
        // landed, not that the CODE is valid — so a model emitting corrupted
        // source rewrites blindly forever. Attaching precise diagnostics + a
        // "fix in place, don't rewrite" directive breaks that loop. null = a
        // non-source/empty/oversized file or a checker error → no signal added.
        const verification = await verifyWrittenSource(resolvedPath, content);
        const largeRewriteHint = largeFileRewriteHint(existed, existedSize);

        // Feed the syntax verdict to the failure-streak breaker (PM #83):
        // invalid extends the streak, valid resets it, no-signal leaves it.
        recordSyntaxOutcome(
          context.chatId,
          resolvedPath,
          verification ? verification.valid : undefined
        );

        return {
          success: true,
          path: resolvedPath,
          bytes: after.size,
          created: !existed,
          overwritten: existed,
          ...(verification
            ? verification.valid
              ? { syntaxValid: true }
              : {
                  syntaxValid: false,
                  syntaxErrors: verification.diagnostics,
                  warning: verification.hint,
                }
            : {}),
          ...(rewriteBudget.action === "warn"
            ? { rewriteWarning: rewriteBudget.message }
            : {}),
          // PM #81 Sprint 3 — advisory nudge toward replace_in_file when a large
          // existing file is fully overwritten (big regenerations provoke format
          // degradation). Does not block the write.
          ...(largeRewriteHint ? { rewriteHint: largeRewriteHint } : {}),
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to write text file.",
        };
      }
    },
  });

  tools.replace_in_file = tool({
    description:
      "Replace a specific string in an existing local UTF-8 text file. Prefer this over write_text_file when making targeted edits to large files to avoid truncating output.",
    inputSchema: z.object({
      file_path: z
        .string()
        .describe("Absolute path, or path relative to current project cwd."),
      target_content: z
        .string()
        .min(1, "Target content cannot be empty.")
        .describe("The exact string to be replaced. Must match exactly once in the file."),
      replacement_content: z
        .string()
        .describe("The new string to replace the target_content with."),
    }),
    execute: async ({ file_path, target_content, replacement_content }) => {
      try {
        const resolvedPath = resolveOutgoingFilePath(context, file_path);
        let existed = false;
        try {
          const before = await fs.stat(resolvedPath);
          if (!before.isFile()) {
            return {
              success: false,
              error: `Target exists and is not a regular file: ${resolvedPath}`,
            };
          }
          existed = true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") throw error;
        }

        if (!existed) {
          return {
            success: false,
            error: `File does not exist: ${resolvedPath}. Use write_text_file to create new files.`,
          };
        }

        const originalContent = await fs.readFile(resolvedPath, "utf-8");

        // Smart CRLF Detection & Adaptation
        // This ensures git diffs remain clean in CRLF repos even if the LLM generates \n
        const isCRLF = originalContent.includes("\r\n");
        const normalizedTarget = isCRLF
          ? target_content.replace(/\r?\n/g, "\r\n")
          : target_content.replace(/\r\n/g, "\n");
        const normalizedReplacement = isCRLF
          ? replacement_content.replace(/\r?\n/g, "\r\n")
          : replacement_content.replace(/\r\n/g, "\n");

        const count = originalContent.split(normalizedTarget).length - 1;
        if (count === 0) {
          // If strict matching failed, try one more time as a fallback to see if it's an indentation or trailing space issue
          // We won't auto-replace to be safe, but we give a better error message
          return {
            success: false,
            error: `Target content not found in ${resolvedPath}. The target_content must match exactly. Check for trailing spaces or indentation differences.`,
          };
        } else if (count > 1) {
          // PM #83 (C) — disambiguation signal instead of a bare count. Report
          // each occurrence's 1-based line number (computed on the SAME
          // normalizedTarget/originalContent pair the count used, so reported
          // lines match counted matches on CRLF files), capped at 10, so the
          // model adds context to make the target unique rather than flailing
          // into a whole-file rewrite. Behaviour is unchanged: the write is
          // still refused — only the message is richer.
          const lines: number[] = [];
          let occ = originalContent.indexOf(normalizedTarget);
          while (occ !== -1 && lines.length < 10) {
            lines.push(originalContent.slice(0, occ).split("\n").length);
            occ = originalContent.indexOf(
              normalizedTarget,
              occ + normalizedTarget.length
            );
          }
          const more =
            count > lines.length ? ` …and ${count - lines.length} more` : "";
          return {
            success: false,
            error:
              `Target content found ${count} times in ${resolvedPath} (lines ${lines.join(", ")}${more}). ` +
              `target_content must match exactly once — add more surrounding context (lines above and/or below) ` +
              `to make it unique, then retry. Do NOT fall back to rewriting the whole file.`,
          };
        }

        // Use split().join() instead of .replace() to avoid $& and $1 regex replacement vulnerabilities
        const newContent = originalContent.split(normalizedTarget).join(normalizedReplacement);

        if (newContent.length > TEXT_FILE_WRITE_MAX_CHARS) {
          return {
            success: false,
            error: `Resulting content too large (${newContent.length} chars). Max allowed is ${TEXT_FILE_WRITE_MAX_CHARS}.`,
          };
        }

        // Failure-keyed cross-turn loop backstop (PM #83) — same breaker as
        // write_text_file. replace_in_file has no raw-count budget (a prior
        // doubt-driven review rejected it as false-positiving legit iterative
        // edits); this failure-keyed gate is its cross-turn backstop.
        const syntaxStreak = checkSyntaxFailureStreak(
          context.chatId,
          resolvedPath
        );
        if (syntaxStreak.action === "block") {
          return { success: false, error: syntaxStreak.message };
        }

        // Snapshot before overwrite
        await snapshotBeforeWrite({
          projectId: context.projectId ?? "none",
          chatId: context.chatId,
          filePath: resolvedPath,
          reason: "replace_in_file modify",
        });

        await fs.writeFile(resolvedPath, newContent, "utf-8");
        const after = await fs.stat(resolvedPath);

        const verification = await verifyWrittenSource(resolvedPath, newContent);

        // Feed the syntax verdict to the failure-streak breaker (PM #83).
        recordSyntaxOutcome(
          context.chatId,
          resolvedPath,
          verification ? verification.valid : undefined
        );

        return {
          success: true,
          path: resolvedPath,
          bytes: after.size,
          ...(verification
            ? verification.valid
              ? { syntaxValid: true }
              : {
                  syntaxValid: false,
                  syntaxErrors: verification.diagnostics,
                  warning: verification.hint,
                }
            : {}),
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to replace in text file.",
        };
      }
    },
  });

  tools.copy_file = tool({
    description:
      "Copy (duplicate) a local file from source_path to destination_path.",
    inputSchema: z.object({
      source_path: z
        .string()
        .describe("Source file path (absolute or relative to current project cwd)."),
      destination_path: z
        .string()
        .describe("Destination file path (absolute or relative to current project cwd)."),
      overwrite: z
        .boolean()
        .default(false)
        .describe("Whether to overwrite destination if it already exists."),
    }),
    execute: async ({ source_path, destination_path, overwrite }) => {
      try {
        const sourceResolved = resolveOutgoingFilePath(context, source_path);
        const destinationResolved = resolveOutgoingFilePath(context, destination_path);

        if (sourceResolved === destinationResolved) {
          return {
            success: false,
            error: "source_path and destination_path must be different.",
          };
        }

        const sourceStat = await fs.stat(sourceResolved);
        if (!sourceStat.isFile()) {
          return {
            success: false,
            error: `Source is not a file: ${sourceResolved}`,
          };
        }

        await fs.mkdir(path.dirname(destinationResolved), { recursive: true });
        await fs.copyFile(
          sourceResolved,
          destinationResolved,
          overwrite ? 0 : fsConstants.COPYFILE_EXCL
        );
        const destinationStat = await fs.stat(destinationResolved);

        return {
          success: true,
          sourcePath: sourceResolved,
          destinationPath: destinationResolved,
          bytes: destinationStat.size,
          overwritten: overwrite,
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to copy file.",
        };
      }
    },
  });

  return tools;
}
