import { NextResponse } from "next/server";
import { getActiveGoal } from "@/lib/storage/goal-store";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId");

  if (!chatId) {
    return NextResponse.json({ goal: null });
  }

  try {
    const goal = await getActiveGoal(chatId);
    if (!goal || goal.status !== "active") {
       return NextResponse.json({ goal: null });
    }
    return NextResponse.json({ goal });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch active goal" },
      { status: 500 }
    );
  }
}
