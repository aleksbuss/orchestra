import { NextRequest } from "next/server";
import fs from "fs/promises";
import { getProjectFiles, getWorkDir } from "@/lib/storage/project-store";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { assertPathInside } from "@/lib/storage/fs-utils";

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("project");
  const subPath = req.nextUrl.searchParams.get("path") || "";

  if (!projectId) {
    return Response.json(
      { error: "Project ID required" },
      { status: 400 }
    );
  }

  const files = await getProjectFiles(projectId, subPath);
  return Response.json(files);
}

export async function DELETE(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("project");
  const filePath = req.nextUrl.searchParams.get("path");

  if (!projectId || !filePath) {
    return Response.json(
      { error: "Project ID and file path required" },
      { status: 400 }
    );
  }

  const workDir = getWorkDir(projectId);

  // PM #6 — `path.join` + `startsWith(workDir)` is NOT a security boundary:
  //   1. `path.join` normalizes `../` silently.
  //   2. A bare `startsWith(workDir)` without `path.sep` accepts sibling
  //      directories that share a prefix (`/data/projects/foo` would accept
  //      a path under `/data/projects/foo-evil`). The audit confirmed this
  //      was a real CVE-class bypass — the regression test for it is in
  //      `route.test.ts` (PM #6 — path traversal).
  // `assertPathInside` does the right thing in one call: realpath-free
  // string check that appends `path.sep` before the prefix comparison.
  let fullPath: string;
  try {
    fullPath = assertPathInside(workDir, filePath);
  } catch {
    return Response.json({ error: "Invalid file path" }, { status: 403 });
  }

  try {
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      await fs.rm(fullPath, { recursive: true });
    } else {
      await fs.unlink(fullPath);
    }
    publishUiSyncEvent({
      topic: "files",
      projectId: projectId === "none" ? null : projectId,
      reason: "file_deleted",
    });
    return Response.json({ success: true });
  } catch {
    return Response.json({ error: "File not found" }, { status: 404 });
  }
}
