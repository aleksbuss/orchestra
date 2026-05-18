"use client";

import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { ChatModelWizard, UtilityModelWizard } from "@/components/settings/model-wizards";
import { updateSettingsByPath } from "@/lib/settings/update-settings-path";
import type { AppSettings } from "@/lib/types";
import { Loader2 } from "lucide-react";

export function CustomPresetSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (open) {
      setLoading(true);
      fetch("/api/settings")
        .then((res) => res.json())
        .then((data) => {
          setSettings(data);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }
  }, [open]);

  // Hook into the same save logic as SettingsPage so the changes persist instantly
  // but we can simply save it automatically when the sheet is closed or debounced.
  useEffect(() => {
    if (!settings || !open) return;
    const t = setTimeout(() => {
      fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      }).catch(console.error);
    }, 1000);
    return () => clearTimeout(t);
  }, [settings, open]);

  function updateSettings(path: string, value: unknown) {
    setSettings((prev) => {
      if (!prev) return null;
      return updateSettingsByPath(prev, path, value);
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[400px] sm:w-[540px] overflow-y-auto">
        <SheetHeader className="mb-6">
          <SheetTitle>Custom Swarm Configuration</SheetTitle>
          <SheetDescription>
            Configure your Brain model (Orchestrator) and Worker models. These settings are applied globally when "Manual config" is active.
          </SheetDescription>
        </SheetHeader>

        {loading || !settings ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="w-8 h-8 animate-spin" />
          </div>
        ) : (
          <div className="space-y-6 pb-6">
            <ChatModelWizard settings={settings} updateSettings={updateSettings} />
            <UtilityModelWizard settings={settings} updateSettings={updateSettings} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
