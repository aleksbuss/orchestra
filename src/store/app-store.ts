"use client";

import { create } from "zustand";
import type { ChatListItem, Project } from "@/lib/types";
import type { PresetTier } from "@/lib/agent/presets";

interface AppState {
  // Chats
  chats: ChatListItem[];
  activeChatId: string | null;
  setChats: (chats: ChatListItem[]) => void;
  setActiveChatId: (id: string | null) => void;
  addChat: (chat: ChatListItem) => void;
  removeChat: (id: string) => void;

  // Projects
  projects: Project[];
  activeProjectId: string | null;
  currentPath: string; // relative path within the project, "" = project root
  setProjects: (projects: Project[]) => void;
  setActiveProjectId: (id: string | null) => void;
  setCurrentPath: (path: string) => void;

  // UI
  sidebarTab: "chats" | "projects";
  setSidebarTab: (tab: "chats" | "projects") => void;

  // Swarm & Background Config
  swarmEnabled: boolean;
  daemonMode: boolean;
  setSwarmEnabled: (enabled: boolean) => void;
  setDaemonMode: (enabled: boolean) => void;

  // Model Presets
  activePreset: PresetTier;
  setActivePreset: (preset: PresetTier) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // Chats
  chats: [],
  activeChatId: null,
  setChats: (chats) => set({ chats }),
  setActiveChatId: (id) => set({ activeChatId: id }),
  addChat: (chat) =>
    set((state) => ({ chats: [chat, ...state.chats] })),
  removeChat: (id) =>
    set((state) => ({
      chats: state.chats.filter((c) => c.id !== id),
      activeChatId: state.activeChatId === id ? null : state.activeChatId,
    })),

  // Projects
  projects: [],
  activeProjectId: null,
  currentPath: "",
  setProjects: (projects) => set({ projects }),
  setActiveProjectId: (id) =>
    set({ activeProjectId: id, activeChatId: null, currentPath: "" }),
  setCurrentPath: (path) => set({ currentPath: path }),

  // UI
  sidebarTab: "chats",
  setSidebarTab: (tab) => set({ sidebarTab: tab }),

  // Swarm
  swarmEnabled: true,
  daemonMode: false,
  setSwarmEnabled: (enabled) => set({ swarmEnabled: enabled }),
  setDaemonMode: (enabled) => set({ daemonMode: enabled }),

  // Model Presets — default to "custom" so we never accidentally override
  // the user's manually-configured model with a preset that requires
  // a different provider/key.
  activePreset: "custom" as PresetTier,
  setActivePreset: (preset) => set({ activePreset: preset }),
}));
