import { NextRequest } from "next/server";
import path from "path";
import { importKnowledge } from "@/lib/memory/knowledge";
import { getSettings } from "@/lib/storage/settings-store";
import { assertPathInside } from "@/lib/storage/fs-utils";

const DATA_DIR = path.join(process.cwd(), "data");
const KNOWLEDGE_ROOT = path.join(DATA_DIR, "knowledge");

// Memory subdir must be a flat identifier — not a path. We use it as a
// segment under `data/memory/` (see `lib/memory/memory.ts:getDbPath`),
// and although that helper has its own `assertPathInside` guard, validating
// at the entry point gives clearer errors and rejects nonsense early.
const SUBDIR_RE = /^[a-zA-Z0-9_-]+$/;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { directory, subdir } = body;

    if (!directory || typeof directory !== "string") {
      return Response.json(
        { error: "Directory path is required" },
        { status: 400 }
      );
    }

    if (subdir !== undefined && (typeof subdir !== "string" || !SUBDIR_RE.test(subdir))) {
      return Response.json(
        { error: "Invalid subdir: must match /^[a-zA-Z0-9_-]+$/" },
        { status: 400 }
      );
    }

    const settings = await getSettings();
    const memorySubdir = subdir || "main";

    // Path resolution rules:
    //   - Relative paths are sandboxed inside `data/knowledge/`. `path.join` is
    //     NOT a security boundary on its own — it normalizes `../../` silently.
    //     Use `assertPathInside` to enforce the sandbox. See PM #6.
    //   - Absolute paths are intentionally allowed as a local-first design
    //     choice: a single trusted operator can ingest documents from any
    //     directory on their own machine. Do NOT expose this route to
    //     untrusted networks; if you ever multi-tenant Orchestra, this branch
    //     becomes an unauthenticated arbitrary file read.
    let knowledgeDir: string;
    if (path.isAbsolute(directory)) {
      knowledgeDir = directory;
    } else {
      try {
        knowledgeDir = assertPathInside(KNOWLEDGE_ROOT, directory);
      } catch {
        return Response.json(
          { error: "Invalid directory: escapes the knowledge sandbox" },
          { status: 400 }
        );
      }
    }

    const result = await importKnowledge(knowledgeDir, memorySubdir, settings);

    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to import knowledge",
      },
      { status: 500 }
    );
  }
}
