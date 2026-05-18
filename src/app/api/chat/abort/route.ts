import { NextRequest } from "next/server";
import { abortJob, isJobActive } from "@/lib/agent/daemon";

export const dynamic = "force-dynamic";

/**
 * POST /api/chat/abort — Cancel a running background agent job.
 * Body: { chatId: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { chatId } = body;

    if (!chatId || typeof chatId !== "string") {
      return Response.json(
        { error: "chatId is required" },
        { status: 400 }
      );
    }

    const wasActive = isJobActive(chatId);
    const aborted = abortJob(chatId);

    return Response.json({
      success: true,
      aborted,
      wasActive,
    });
  } catch (error) {
    console.error("Abort API error:", error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
