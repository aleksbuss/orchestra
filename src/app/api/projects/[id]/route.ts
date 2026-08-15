import { NextRequest } from "next/server";
import {
  getProject,
  updateProject,
  deleteProject,
  InvalidProjectRootError,
} from "@/lib/storage/project-store";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  return Response.json(project);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();

  // The body is spread into the stored project, so `absoluteRoot` — the
  // project's filesystem root — is settable from here. `updateProject`
  // validates it; surface the rejection as a 400 instead of a 500.
  let updated;
  try {
    updated = await updateProject(id, body);
  } catch (error) {
    if (error instanceof InvalidProjectRootError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  if (!updated) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  publishUiSyncEvent({
    topic: "projects",
    projectId: id,
    reason: "[Project] Project updated.",
  });
  return Response.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const deleted = await deleteProject(id);
  if (!deleted) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  publishUiSyncEvent({
    topic: "projects",
    projectId: id,
    reason: "[Project] Project deleted.",
  });
  return Response.json({ success: true });
}
