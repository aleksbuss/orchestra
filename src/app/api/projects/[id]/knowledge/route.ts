
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import { importKnowledgeFile } from "@/lib/memory/knowledge";
import { deleteMemoryByMetadata, getChunkCountsByFilename } from "@/lib/memory/memory";
import { getProject } from "@/lib/storage/project-store";
import { getSettings } from "@/lib/storage/settings-store";
import { assertPathInside } from "@/lib/storage/fs-utils";

/**
 * Sanitize a user-supplied filename for use inside the project's knowledge
 * directory. Rejects path traversal payloads (`../`, separator-containing
 * names, `.`/`..`) by returning null; the caller is expected to surface
 * a 400 in that case. See PM #21 — the previous implementation passed
 * `file.name` straight into `path.join`, allowing arbitrary write/delete
 * primitives for any authenticated user (same bug class as PM #6 and #16).
 */
function sanitizeKnowledgeFilename(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // Reject either separator explicitly. `path.basename` is POSIX-aware on
    // POSIX runtimes (treats `/` as separator but not `\`), so a name like
    // "..\\..\\foo" would pass basename verbatim on Linux/macOS while being
    // a traversal on Windows. We refuse both unconditionally.
    if (trimmed.includes("/") || trimmed.includes("\\")) return null;
    const basename = path.basename(trimmed);
    if (!basename || basename === "." || basename === "..") return null;
    if (basename !== trimmed) return null;
    return basename;
}

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const projectDir = path.join(process.cwd(), "data", "projects", id);
    const knowledgeDir = path.join(projectDir, ".meta", "knowledge");

    try {
        await fs.access(knowledgeDir);
    } catch {
        return NextResponse.json([]);
    }

    try {
        const files = await fs.readdir(knowledgeDir);
        const chunkCounts = await getChunkCountsByFilename(id);
        const fileDetails = await Promise.all(
            files.map(async (file) => {
                const stats = await fs.stat(path.join(knowledgeDir, file));
                return {
                    name: file,
                    size: stats.size,
                    createdAt: stats.birthtime,
                    chunkCount: chunkCounts[file] ?? 0,
                };
            })
        );
        return NextResponse.json(fileDetails);
    } catch (error) {
        return NextResponse.json(
            { error: "Failed to list knowledge files" },
            { status: 500 }
        );
    }
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    // Verify project exists
    const project = await getProject(id);
    if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File;

    if (!file) {
        return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // PM #21 — path traversal guard. `file.name` comes from the user-controlled
    // multipart Content-Disposition and was previously joined raw into the
    // knowledge dir, giving any authed user an arbitrary file-write primitive.
    const safeName = sanitizeKnowledgeFilename(file.name);
    if (!safeName) {
        return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    }

    const projectDir = path.join(process.cwd(), "data", "projects", id);
    const knowledgeDir = path.join(projectDir, ".meta", "knowledge");

    // Ensure knowledge directory exists
    await fs.mkdir(knowledgeDir, { recursive: true });

    const buffer = Buffer.from(await file.arrayBuffer());

    // Defense-in-depth — `sanitizeKnowledgeFilename` already strips
    // separators, but `assertPathInside` is the canonical sandbox check
    // (PM #16) and is cheap to call.
    let filePath: string;
    try {
        filePath = assertPathInside(knowledgeDir, safeName);
    } catch {
        return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    }

    try {
        // Save file
        await fs.writeFile(filePath, buffer);

        // Ingest only the uploaded file (removes its old chunks first, so no duplicates)
        const settings = await getSettings();
        const result = await importKnowledgeFile(knowledgeDir, id, settings, safeName);

        if (result.errors.length > 0) {
            console.error("Ingestion errors:", result.errors);
            return NextResponse.json(
                {
                    message: "File saved but ingestion had errors",
                    details: result
                },
                { status: 207 } // Multi-Status
            );
        }

        return NextResponse.json({
            message: "File uploaded and ingested successfully",
            filename: safeName
        });

    } catch (error) {
        console.error("Upload error:", error);
        return NextResponse.json(
            { error: "Failed to process file" },
            { status: 500 }
        );
    }
}

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    // Verify project exists
    const project = await getProject(id);
    if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    try {
        const { filename } = await req.json();

        if (!filename) {
            return NextResponse.json({ error: "Filename is required" }, { status: 400 });
        }

        // PM #21 — path traversal guard. `filename` is user-controlled JSON
        // body and was previously joined raw into the knowledge dir, giving
        // any authed user an arbitrary file-delete primitive.
        const safeName = sanitizeKnowledgeFilename(filename);
        if (!safeName) {
            return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
        }

        const projectDir = path.join(process.cwd(), "data", "projects", id);
        const knowledgeDir = path.join(projectDir, ".meta", "knowledge");

        let filePath: string;
        try {
            filePath = assertPathInside(knowledgeDir, safeName);
        } catch {
            return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
        }

        // Delete file from disk
        try {
            await fs.unlink(filePath);
        } catch (error: any) {
            if (error.code !== "ENOENT") {
                throw error;
            }
            // If file doesn't exist, we still try to delete vectors
        }

        // Delete vectors — use the sanitized name so DB lookup matches what
        // was actually persisted (importKnowledgeFile keyed by safeName too).
        const deletedVectors = await deleteMemoryByMetadata("filename", safeName, id);

        return NextResponse.json({
            message: "File and vectors deleted successfully",
            deletedVectors
        });

    } catch (error) {
        console.error("Delete error:", error);
        return NextResponse.json(
            { error: "Failed to delete file" },
            { status: 500 }
        );
    }
}
