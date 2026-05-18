"use client";

import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function ThemeSwitcher() {
  const [isDark, setIsDark] = React.useState<boolean | null>(null);
  const router = useRouter();

  React.useEffect(() => {
    // Read the current class on mount to prevent hydration mismatch
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggleTheme = async () => {
    if (isDark === null) return;
    const newDark = !isDark;

    // Optimistic UI update + persist to localStorage so the next page load's
    // pre-paint bootstrap (`src/app/layout.tsx`) picks the same value without
    // hitting the server. PM #15 — keeps the root layout free of any
    // auth-bearing FS reads.
    setIsDark(newDark);
    if (newDark) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
    try {
      localStorage.setItem("orchestra-theme", newDark ? "dark" : "light");
    } catch {
      // Private-mode / quota — non-fatal. The class change above is what
      // governs THIS page; localStorage is for the next load.
    }

    try {
      // Background sync to server API so the canonical `data/settings/settings.json`
      // remains a single source of truth for any authenticated UI that wants
      // to read it (settings page, multi-device export). The server value is
      // NOT used during SSR anymore (PM #15).
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ general: { darkMode: newDark } }),
      });
      // Refresh to ensure server-rendered components align with the new preference
      router.refresh();
    } catch (e) {
      console.error("Failed to sync theme setting:", e);
      // Revert optimism if network failed (optional but good practice)
      setIsDark(isDark);
      if (isDark) {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
      try {
        localStorage.setItem("orchestra-theme", isDark ? "dark" : "light");
      } catch { /* ignore */ }
    }
  };

  if (isDark === null) {
    // Return a placeholder of the same size to avoid layout shift
    return <div className="h-8 w-8" />;
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      className="h-8 w-8 text-muted-foreground hover:text-foreground transition-colors"
      title="Toggle Theme"
    >
      {isDark ? (
        <Moon className="h-[1.2rem] w-[1.2rem] transition-all" />
      ) : (
        <Sun className="h-[1.2rem] w-[1.2rem] transition-all" />
      )}
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}
