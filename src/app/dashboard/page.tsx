import { ChatPanel } from "@/components/chat/chat-panel"

export const dynamic = "force-dynamic"

export default function DashboardPage() {
  return (
    <div className="flex-1 min-h-0 px-4 pb-4 pt-2">
      <div className="flex flex-1 flex-col h-full min-h-0 bg-card/40 backdrop-blur-3xl rounded-[2rem] overflow-hidden shadow-2xl border border-border/70 ring-1 ring-border/50 relative">
        <ChatPanel />
      </div>
    </div>
  )
}
