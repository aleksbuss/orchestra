import fs from "fs/promises";
import path from "path";
import type { ChatFile } from "@/lib/types";
import { assertPathInside } from "./fs-utils";
import { getDataDir } from "@/lib/storage/data-dir";

const DATA_DIR = getDataDir();
const CHAT_FILES_DIR = path.join(DATA_DIR, "chat-files");

/**
 * Get the directory path for a chat's uploaded files
 */
export function getChatFilesDir(chatId: string): string {
    return path.join(CHAT_FILES_DIR, chatId);
}

/**
 * Ensure the chat files directory exists
 */
async function ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
}

/**
 * Get all files uploaded to a specific chat
 */
export async function getChatFiles(chatId: string): Promise<ChatFile[]> {
    const dir = getChatFilesDir(chatId);

    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const files: ChatFile[] = [];

        for (const entry of entries) {
            if (entry.isFile()) {
                const fullPath = path.join(dir, entry.name);
                // Sprint 11 defensive — `fs.stat` follows symlinks. If a
                // TOCTOU race between readdir (Dirent type from d_type) and
                // stat lets a symlink slip past `isFile()` (e.g. inode
                // replaced between the two syscalls), `fs.stat` would
                // happily read the target's metadata (size, mtime) of a
                // sensitive file like /etc/passwd. `fs.lstat` returns
                // metadata for the LINK itself, not the target, closing
                // the TOCTOU. Cost: one syscall, same surface.
                const stat = await fs.lstat(fullPath);
                // Belt-and-suspenders: if the entry is now a symlink
                // (post-TOCTOU), skip it. `Dirent.isFile()` from readdir
                // already excludes symlinks, so this should be unreachable
                // under normal conditions.
                if (stat.isSymbolicLink()) continue;
                const ext = path.extname(entry.name).toLowerCase();

                files.push({
                    name: entry.name,
                    path: fullPath,
                    size: stat.size,
                    type: getFileType(ext),
                    uploadedAt: stat.mtime.toISOString(),
                });
            }
        }

        return files;
    } catch (error) {
        // Directory doesn't exist yet - no files uploaded
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        throw error;
    }
}

/**
 * Save a file to a chat's files directory
 */
export async function saveChatFile(
    chatId: string,
    fileBuffer: Buffer,
    filename: string
): Promise<ChatFile> {
    const dir = getChatFilesDir(chatId);
    await ensureDir(dir);

    // Sanitize filename to prevent path traversal
    const safeName = path.basename(filename);
    const fullPath = path.join(dir, safeName);

    await fs.writeFile(fullPath, fileBuffer);
    const stat = await fs.stat(fullPath);
    const ext = path.extname(safeName).toLowerCase();

    return {
        name: safeName,
        path: fullPath,
        size: stat.size,
        type: getFileType(ext),
        uploadedAt: new Date().toISOString(),
    };
}

/**
 * Delete a file from a chat's files directory
 */
export async function deleteChatFile(
    chatId: string,
    filename: string
): Promise<boolean> {
    const dir = getChatFilesDir(chatId);
    // `path.basename` already strips traversal segments from `filename`, so
    // for the typical caller this is belt-and-braces. We still validate via
    // `assertPathInside` because the function is exported and the audit
    // (PM #6) found the same broken `startsWith(dir)`-without-`path.sep`
    // pattern in two sibling routes — keeping the deep-defense check here
    // means a future caller passing an unsanitized `filename` doesn't open
    // a regression of that bug class.
    const safeName = path.basename(filename);

    let fullPath: string;
    try {
        fullPath = assertPathInside(dir, safeName);
    } catch {
        return false;
    }

    try {
        await fs.unlink(fullPath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Delete all files for a chat (when chat is deleted)
 */
export async function deleteAllChatFiles(chatId: string): Promise<void> {
    const dir = getChatFilesDir(chatId);
    try {
        await fs.rm(dir, { recursive: true, force: true });
    } catch {
        // Ignore errors - directory may not exist
    }
}

/**
 * Get MIME type or simple type from file extension
 */
function getFileType(ext: string): string {
    const mimeTypes: Record<string, string> = {
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".json": "application/json",
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".csv": "text/csv",
        ".xml": "application/xml",
        ".html": "text/html",
        ".css": "text/css",
        ".js": "application/javascript",
        ".ts": "application/typescript",
        ".py": "text/x-python",
        ".doc": "application/msword",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xls": "application/vnd.ms-excel",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };

    return mimeTypes[ext] || "application/octet-stream";
}
