import { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getWorkDir } from "@/lib/storage/project-store";
import { assertPathInsideRealpath } from "@/lib/storage/fs-utils";

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("project");
  const filePath = req.nextUrl.searchParams.get("path");

  if (!projectId || !filePath) {
    return Response.json(
      { error: "Project ID and file path required" },
      { status: 400 }
    );
  }

  const workDir = getWorkDir(projectId);

  // PM #6 — see `src/app/api/files/route.ts` for the full rationale. Same
  // class of bug, same fix: never trust `path.join` + `startsWith` without
  // `path.sep`. Read-paths are even more sensitive than delete-paths because
  // they can exfiltrate arbitrary readable files (e.g. `data/settings/`).
  // PM #105 — realpath variant: a linked project's root is the user's own
  // directory tree, and a symlink there defeats a string-only guard.
  let fullPath: string;
  try {
    fullPath = await assertPathInsideRealpath(workDir, filePath);
  } catch {
    return Response.json({ error: "Invalid file path" }, { status: 403 });
  }

  try {
    const content = await fs.readFile(fullPath);
    const fileName = path.basename(filePath);

    return new Response(content, {
      headers: {
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Type": "application/octet-stream",
      },
    });
  } catch {
    return Response.json({ error: "File not found" }, { status: 404 });
  }
}
