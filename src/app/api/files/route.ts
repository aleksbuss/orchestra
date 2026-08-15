import { NextRequest } from "next/server";
import fs from "fs/promises";
import { getProjectFiles, getProjectContentRoot } from "@/lib/storage/project-store";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { assertPathInsideRealpath } from "@/lib/storage/fs-utils";

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("project");
  const subPath = req.nextUrl.searchParams.get("path") || "";

  if (!projectId) {
    return Response.json(
      { error: "Project ID required" },
      { status: 400 }
    );
  }

  // PM #16 — `path.join(baseDir, subPath)` inside getProjectFiles normalizes
  // `../` silently, so `?path=../..` would `fs.readdir` outside the project
  // sandbox (directory enumeration of data/settings, data/chats, …). The
  // DELETE handler below already guards; the GET side was the gap. Validate
  // at the route layer AND push down into getProjectFiles (defense-in-depth).
  //
  // PM #105 — the REALPATH variant, not the string one. A project root can be
  // a directory the user owns (linked projects / Open Folder), and a symlink
  // inside it — `<root>/logs -> /Users/me/.ssh` — passes a string-only check.
  if (subPath) {
    try {
      await assertPathInsideRealpath(
        await getProjectContentRoot(projectId),
        subPath
      );
    } catch {
      return Response.json({ error: "Invalid path" }, { status: 400 });
    }
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

  const workDir = await getProjectContentRoot(projectId);

  // PM #6 — `path.join` + `startsWith(workDir)` is NOT a security boundary:
  //   1. `path.join` normalizes `../` silently.
  //   2. A bare `startsWith(workDir)` without `path.sep` accepts sibling
  //      directories that share a prefix (`/data/projects/foo` would accept
  //      a path under `/data/projects/foo-evil`). The audit confirmed this
  //      was a real CVE-class bypass — the regression test for it is in
  //      `route.test.ts` (PM #6 — path traversal).
  // PM #105 — use the realpath guard, not the string one: on a linked project
  // the root is the user's own repo, where a symlink pointing outside it is
  // both legal and invisible to a `path.resolve`-only check. `rm -rf` through
  // a symlink is the destructive half of the same hole.
  let fullPath: string;
  try {
    fullPath = await assertPathInsideRealpath(workDir, filePath);
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
