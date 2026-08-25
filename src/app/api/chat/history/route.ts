import { NextRequest } from "next/server";
import { getAllChats, getChat, deleteChat, isValidChatId } from "@/lib/storage/chat-store";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";

export async function GET(req: NextRequest) {
  const chatId = req.nextUrl.searchParams.get("id");

  if (chatId) {
    // `id` is a user-supplied path fragment (`data/chats/<id>.json`). The
    // storage guard throws on traversal; catch it here so the answer is a 400
    // rather than an unhandled 500 (non-negotiable #2 — route layer AND pushed
    // down).
    if (!isValidChatId(chatId)) {
      return Response.json({ error: "invalid chat id" }, { status: 400 });
    }
    const chat = await getChat(chatId);
    if (!chat) {
      return Response.json({ error: "Chat not found" }, { status: 404 });
    }
    return Response.json(chat);
  }

  const projectId = req.nextUrl.searchParams.get("projectId");
  let chats = await getAllChats();

  // Filter by project: "none" means global chats (no project),
  // a project ID filters to that project's chats
  if (projectId === "none") {
    chats = chats.filter((c) => !c.projectId);
  } else if (projectId) {
    chats = chats.filter((c) => c.projectId === projectId);
  }

  return Response.json(chats);
}

export async function DELETE(req: NextRequest) {
  const chatId = req.nextUrl.searchParams.get("id");
  if (!chatId) {
    return Response.json({ error: "Chat ID required" }, { status: 400 });
  }
  // Same guard as GET, and it matters more here: `deleteChat` calls
  // `chatFilePath` OUTSIDE its own try/catch, so a traversal id threw straight
  // through a DELETE handler.
  if (!isValidChatId(chatId)) {
    return Response.json({ error: "invalid chat id" }, { status: 400 });
  }

  const deleted = await deleteChat(chatId);
  if (!deleted) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  // Sidebar/chat list subscribes to "chat" — without this broadcast the
  // deleted chat stays in the list until the next focus/visibility resync.
  publishUiSyncEvent({ topic: "chat", chatId, reason: "[Chat] Chat deleted." });

  return Response.json({ success: true });
}
