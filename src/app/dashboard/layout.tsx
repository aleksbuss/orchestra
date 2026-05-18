"use client";

import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { usePathname } from "next/navigation";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  
  // Determine a simple dynamic title based on the route
  let title = "Nexus Agent";
  if (pathname.includes("/projects")) title = "Projects";
  if (pathname.includes("/memory")) title = "Memory";
  if (pathname.includes("/skills")) title = "Skills";
  if (pathname.includes("/settings")) title = "Settings";
  if (pathname.includes("/cron")) title = "Cron Jobs";
  if (pathname.includes("/mcp")) title = "MCP Config";

  return (
    <div className="[--header-height:calc(--spacing(20))] h-[100svh] flex flex-col overflow-hidden">
      <SidebarProvider className="flex flex-col h-full">
        <SiteHeader title={title} />
        <div className="flex flex-1 overflow-hidden">
          <AppSidebar />
          <SidebarInset className="flex-1 overflow-hidden">
            {children}
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
