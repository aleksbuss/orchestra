"use client"

import { SidebarIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { useSidebar } from "@/components/ui/sidebar"
import { ThemeSwitcher } from "@/components/theme-switcher"
import { SwarmConfig } from "@/components/chat/swarm-config"

export function SiteHeader({ title }: { title?: string }) {
  const { toggleSidebar } = useSidebar()

  return (
    <header className="sticky top-0 z-50 flex w-full h-(--header-height) items-center border-b border-border/50 bg-background/60 backdrop-blur-xl pt-2 pb-2">
      <div className="flex h-full w-full items-center gap-3 px-4">
        <Button
          className="h-8 w-8 text-muted-foreground hover:bg-muted hover:text-foreground transition-all rounded-md"
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          aria-label="Toggle sidebar"
        >
          <SidebarIcon className="w-4 h-4" />
        </Button>
        
        <Separator orientation="vertical" className="h-4" />
        
        <h1 className="text-sm font-semibold tracking-tight hidden md:block">
          {title || "Orchestra"}
        </h1>
        
        {/* The header height is FIXED (`--header-height` feeds the sidebar's
            top/height math in app-sidebar.tsx), so the pill strip must never
            wrap to a second row. On narrow viewports it scrolls horizontally
            instead — centered while it fits, swipeable when it doesn't. */}
        <div className="flex-1 flex justify-center min-w-0 px-1 sm:px-4">
          <div className="max-w-full overflow-x-auto scrollbar-none rounded-xl bg-foreground/[0.03] backdrop-blur-md border border-border/70 px-2 py-1.5 shadow-sm">
            <SwarmConfig />
          </div>
        </div>

        <div className="ml-auto flex items-center gap-4 pr-2 shrink-0">
          <ThemeSwitcher />
        </div>
      </div>
    </header>
  )
}
