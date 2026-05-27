"use client";

import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import {
  CalendarClock,
  Cable,
  AudioLines,
  Brain,
  FolderOpen,
  LogOut,
  MessageSquarePlus,
  MessagesSquare,
  Puzzle,
  Settings2,
  Trash2,
  Wrench,
} from "lucide-react";
import { useAppStore } from "@/store/app-store";
import { FileTree } from "@/components/file-tree";
import { useBackgroundSync } from "@/hooks/use-background-sync";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const router = useRouter();
  const pathname = usePathname();
  const {
    chats,
    setChats,
    activeChatId,
    setActiveChatId,
    removeChat,
    projects,
    setProjects,
    activeProjectId,
    setActiveProjectId,
  } = useAppStore();
  const projectsTick = useBackgroundSync({
    topics: ["projects", "global"],
  });
  const chatsTick = useBackgroundSync({
    topics: ["chat", "projects", "global"],
    projectId: activeProjectId ?? null,
  });

  const isOnChatPage = pathname === "/dashboard";

  // Navigate to chat page when not already there (e.g. from settings/projects/memory)
  const goToChatIfNeeded = React.useCallback(() => {
    if (!isOnChatPage) router.push("/dashboard");
  }, [isOnChatPage, router]);

  // Keep projects list in sync with background updates.
  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setProjects(data);
      })
      .catch(() => {});
  }, [setProjects, projectsTick]);

  // Keep active project aligned with available projects.
  // If the previously active project was deleted, fall back to global (null)
  // instead of auto-selecting the first project — the user may want to chat
  // without a project context.
  useEffect(() => {
    if (projects.length === 0) {
      if (activeProjectId !== null) setActiveProjectId(null);
      return;
    }

    // Only reset if the user had an active project that no longer exists
    if (activeProjectId !== null) {
      const activeExists = projects.some((project) => project.id === activeProjectId);
      if (!activeExists) {
        setActiveProjectId(null);
      }
    }
  }, [projects, activeProjectId, setActiveProjectId]);

  // Keep chat list synced for the active project (or global mode).
  useEffect(() => {
    const params = new URLSearchParams();
    if (activeProjectId) {
      params.set("projectId", activeProjectId);
    }
    // When no project is active, omit projectId to get global/all chats
    fetch(`/api/chat/history?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setChats(data);
      })
      .catch(() => {});
  }, [activeProjectId, setChats, chatsTick]);

  const handleNewChat = () => {
    setActiveChatId(null);
    goToChatIfNeeded();
  };

  const handleChatClick = (chatId: string) => {
    setActiveChatId(chatId);
    goToChatIfNeeded();
  };

  const handleProjectClick = (projectId: string) => {
    const params = new URLSearchParams({ projectId });
    fetch(`/api/chat/history?${params}`)
      .then((r) => r.json())
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setChats(list);
        setActiveProjectId(projectId);
        setActiveChatId(list[0]?.id ?? null);
        goToChatIfNeeded();
      })
      .catch(() => {
        setActiveProjectId(projectId);
        setActiveChatId(null);
        goToChatIfNeeded();
      });
  };

  const handleDeleteChat = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`/api/chat/history?id=${id}`, { method: "DELETE" });
    removeChat(id);
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore logout request errors and continue redirect
    } finally {
      router.push("/login");
      router.refresh();
    }
  };

  return (
    <Sidebar
      className="top-(--header-height) h-[calc(100svh-var(--header-height))]! border-r border-border/40 bg-sidebar/50 backdrop-blur-xl"
      {...props}
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="hover:bg-muted/50 rounded-xl transition-colors">
              <Link href="/dashboard" className="flex items-center gap-2 p-1">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-foreground text-background shadow-sm">
                  <AudioLines className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold tracking-tight">Orchestra</span>
                  <span className="truncate text-xs text-muted-foreground">Nexus Agent</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {/* New Chat button */}
        <div className="px-3 pt-2">
          <Button
            variant="outline"
            className="w-full justify-start gap-2 rounded-xl border-border/50 bg-background/50 backdrop-blur-sm shadow-sm hover:bg-muted transition-all"
            onClick={handleNewChat}
          >
            <MessageSquarePlus className="size-4" />
            New Chat
          </Button>
        </div>
      </SidebarHeader>

      <SidebarContent>

        {/* Project selector */}
        <SidebarGroup>
          <SidebarGroupLabel className="text-xs font-medium text-muted-foreground">Project</SidebarGroupLabel>
          <SidebarMenu>
            {projects.length === 0 && (
              <SidebarMenuItem>
                <SidebarMenuButton disabled>
                  <span className="text-muted-foreground text-xs">
                    No projects yet
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            {projects.map((project) => (
              <SidebarMenuItem key={project.id}>
                <SidebarMenuButton
                  isActive={activeProjectId === project.id}
                  onClick={() => handleProjectClick(project.id)}
                  className="rounded-lg transition-colors"
                >
                  <FolderOpen className="size-4" />
                  <span className="truncate">{project.name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>

        {/* File tree */}
        <SidebarGroup>
          <SidebarGroupLabel className="text-xs font-medium text-muted-foreground flex items-center">
            <FolderOpen className="size-3.5 mr-1.5" />
            Files
          </SidebarGroupLabel>
          <div className="px-2">
            <FileTree projectId={activeProjectId ?? "none"} />
          </div>
        </SidebarGroup>

        {/* Chat history (PM #33 — paginate + filter to keep the sidebar
           responsive past several hundred chats). */}
        <SidebarChatList
          chats={chats}
          activeChatId={activeChatId}
          onChatClick={handleChatClick}
          onDeleteChat={handleDeleteChat}
        />

      </SidebarContent>

      <SidebarFooter>
        <SidebarGroup>
          <SidebarGroupLabel className="text-xs font-medium text-muted-foreground">Navigation</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild className="rounded-lg transition-colors">
                <Link href="/dashboard/projects">
                  <FolderOpen className="size-4" />
                  <span>Projects</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild className="rounded-lg transition-colors">
                <Link href="/dashboard/memory">
                  <Brain className="size-4" />
                  <span>Memory</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild className="rounded-lg transition-colors">
                <Link href="/dashboard/skills">
                  <Puzzle className="size-4" />
                  <span>Skills</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild className="rounded-lg transition-colors">
                <Link href="/dashboard/mcp">
                  <Wrench className="size-4" />
                  <span>MCP</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild className="rounded-lg transition-colors">
                <Link href="/dashboard/cron">
                  <CalendarClock className="size-4" />
                  <span>Cron Jobs</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild className="rounded-lg transition-colors">
                <Link href="/dashboard/settings">
                  <Settings2 className="size-4" />
                  <span>Settings</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild className="rounded-lg transition-colors">
                <Link href="/dashboard/api">
                  <Cable className="size-4" />
                  <span>API</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild className="rounded-lg transition-colors">
                <Link href="/dashboard/messengers">
                  <MessagesSquare className="size-4" />
                  <span>Messengers</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={handleLogout} className="rounded-lg transition-colors hover:text-destructive">
                <LogOut className="size-4" />
                <span>Logout</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * Sidebar chat list (PM #33). Past ~200 chats, rendering the entire list on
 * every store update — which happens on every SSE sync tick — froze the
 * sidebar interaction layer on low-end devices. Two cheap mitigations,
 * deliberately NOT a virtualization library:
 *   1. Show the first `INITIAL_LIMIT` chats by default. The list is already
 *      sorted by `updatedAt` desc, so this is "the chats you actually use
 *      right now"; the rest is one click away.
 *   2. Live filter by title — when the operator has 1000 chats they search
 *      by name, not scroll-and-recognise.
 * If a real user reports lag past these mitigations, add @tanstack/react-virtual
 * — see CLAUDE.md § "UI Standards" rule on virtualisation thresholds.
 */
const INITIAL_LIMIT = 30;

/**
 * Pure helper for the filter + pagination math. Exported so it can be unit
 * tested without booting the sidebar provider tree, and called from the
 * `SidebarChatList` component below. Keeps the React layer dumb.
 */
export function filterAndPaginateChats(
  chats: ReadonlyArray<{ id: string; title?: string }>,
  filter: string,
  showAll: boolean,
  initialLimit: number = INITIAL_LIMIT
): {
  visible: typeof chats;
  hiddenCount: number;
} {
  const trimmed = filter.trim();
  const filtered = trimmed
    ? chats.filter((c) =>
        (c.title ?? "").toLowerCase().includes(trimmed.toLowerCase())
      )
    : chats;
  // When the operator searches, ALWAYS show all matches — pagination doesn't
  // serve a "find this needle" interaction. Pagination only collapses the
  // unfiltered default view.
  if (trimmed || showAll) {
    return { visible: filtered, hiddenCount: 0 };
  }
  return {
    visible: filtered.slice(0, initialLimit),
    hiddenCount: Math.max(0, filtered.length - initialLimit),
  };
}

interface SidebarChatListProps {
  chats: import("@/lib/types").ChatListItem[];
  activeChatId: string | null;
  onChatClick: (id: string) => void;
  onDeleteChat: (id: string, e: React.MouseEvent) => void;
}

function SidebarChatList({
  chats,
  activeChatId,
  onChatClick,
  onDeleteChat,
}: SidebarChatListProps) {
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);

  const { visible, hiddenCount } = useMemo(
    () => filterAndPaginateChats(chats, filter, showAll),
    [chats, filter, showAll]
  );

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="text-xs font-medium text-muted-foreground flex items-center">
        <MessagesSquare className="size-3.5 mr-1.5" />
        Chats
      </SidebarGroupLabel>

      {chats.length > 5 && (
        <div className="px-2 pb-1">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter chats…"
            aria-label="Filter chats"
            className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          />
        </div>
      )}

      <SidebarMenu>
        {visible.length === 0 && (
          <SidebarMenuItem>
            <SidebarMenuButton disabled>
              <span className="text-muted-foreground text-xs">
                {filter.trim() ? "No matches" : "No chats yet"}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
        {visible.map((chat) => (
          <SidebarMenuItem key={chat.id}>
            <SidebarMenuButton
              isActive={activeChatId === chat.id}
              onClick={() => onChatClick(chat.id)}
              className="rounded-lg transition-colors"
            >
              <span className="truncate">{chat.title}</span>
            </SidebarMenuButton>
            <SidebarMenuAction
              onClick={(e) => onDeleteChat(chat.id, e)}
              className="opacity-0 group-hover/menu-item:opacity-100 text-muted-foreground hover:text-destructive transition-colors"
            >
              <Trash2 className="size-3.5" />
            </SidebarMenuAction>
          </SidebarMenuItem>
        ))}
        {hiddenCount > 0 && (
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => setShowAll(true)}
              className="rounded-lg text-xs text-muted-foreground hover:text-foreground"
            >
              <span>Show {hiddenCount} more…</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
