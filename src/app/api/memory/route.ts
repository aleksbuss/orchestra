import { NextRequest } from "next/server";
import {
  searchMemory,
  insertMemory,
  deleteMemoryById,
  getAllMemories,
} from "@/lib/memory/memory";
import { getSettings } from "@/lib/storage/settings-store";
import { assertPrivacyModeAllowsSettings } from "@/lib/agent/agent";
import type { AppSettings } from "@/lib/types";

/**
 * Privacy Mode air-gap at the route boundary (PM #47/#58 class — QA audit
 * F-19). `searchMemory`/`insertMemory` embed the query/text via the configured
 * embeddingsModel; under Privacy Mode a cloud embeddings provider would ship
 * that text off-box. The agent entry points guard this, but THIS route is a
 * separate, non-agent embedding entry point and must guard independently.
 * Returns a 403 Response when blocked, or null to proceed.
 */
function privacyModeBlocked(settings: AppSettings): Response | null {
  try {
    assertPrivacyModeAllowsSettings(settings);
    return null;
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Privacy Mode blocks this operation." },
      { status: 403 }
    );
  }
}

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("query");
  const subdir = req.nextUrl.searchParams.get("subdir") || "main";
  const limit = parseInt(req.nextUrl.searchParams.get("limit") || "20");

  if (query) {
    const settings = await getSettings();
    const blocked = privacyModeBlocked(settings);
    if (blocked) return blocked;
    const results = await searchMemory(
      query,
      limit,
      settings.memory.similarityThreshold,
      subdir,
      settings
    );
    return Response.json(results);
  }

  // Return all memories for dashboard
  const memories = await getAllMemories(subdir);
  return Response.json(memories);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { text, area, subdir } = body;

    if (!text) {
      return Response.json({ error: "Text is required" }, { status: 400 });
    }

    const settings = await getSettings();
    const blocked = privacyModeBlocked(settings);
    if (blocked) return blocked;
    const id = await insertMemory(
      text,
      area || "main",
      subdir || "main",
      settings
    );

    return Response.json({ id, success: true }, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to save memory",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  const subdir = req.nextUrl.searchParams.get("subdir") || "main";

  if (!id) {
    return Response.json({ error: "Memory ID required" }, { status: 400 });
  }

  const deleted = await deleteMemoryById(id, subdir);
  if (!deleted) {
    return Response.json({ error: "Memory not found" }, { status: 404 });
  }

  return Response.json({ success: true });
}
