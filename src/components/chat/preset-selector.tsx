"use client";

import React from "react";
import { useAppStore } from "@/store/app-store";
import { PRESETS, PRESET_ORDER, type PresetTier } from "@/lib/agent/presets";
import { Crown, Zap, Leaf, Settings, Cpu } from "lucide-react";
import { useState } from "react";
import { CustomPresetSheet } from "./custom-preset-sheet";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  crown: Crown,
  zap: Zap,
  leaf: Leaf,
  settings: Settings,
  cpu: Cpu,
};

const ACCENT_STYLES: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  amber: {
    bg: "bg-amber-500/12",
    border: "border-amber-500/40",
    text: "text-amber-400",
    dot: "bg-amber-400",
  },
  blue: {
    bg: "bg-blue-500/12",
    border: "border-blue-500/40",
    text: "text-blue-400",
    dot: "bg-blue-400",
  },
  emerald: {
    bg: "bg-emerald-500/12",
    border: "border-emerald-500/40",
    text: "text-emerald-400",
    dot: "bg-emerald-400",
  },
  violet: {
    bg: "bg-secondary/12",
    border: "border-secondary/40",
    text: "text-secondary",
    dot: "bg-secondary",
  },
};

export function PresetSelector() {
  const { activePreset, setActivePreset } = useAppStore();
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <>
      <div className="flex items-center gap-1">
        {PRESET_ORDER.map((tier) => {
          const isCustom = tier === "custom";
          const preset = isCustom ? null : PRESETS[tier as Exclude<PresetTier, "custom">];
          const isActive = activePreset === tier;

          const label = preset?.label ?? "Custom";
          const iconKey = preset?.icon ?? "settings";
          const IconComponent = ICONS[iconKey];
          const accent = preset ? ACCENT_STYLES[preset.accentColor] : null;

          return (
            <button
              key={tier}
              type="button"
              onClick={() => {
                setActivePreset(tier);
                if (isCustom) setSheetOpen(true);
              }}
              title={preset?.description ?? "Use your custom model settings from the Settings page."}
              aria-pressed={isActive}
              className={`
                group relative inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg
                border text-xs font-medium transition-colors duration-200
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
                ${isActive
                  ? accent
                    ? `${accent.bg} ${accent.border} ${accent.text}`
                    : "bg-primary/12 border-primary/40 text-primary"
                  : "bg-transparent border-transparent text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
                }
              `}
            >
              <IconComponent className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden sm:inline">{label}</span>
              {isActive && (
                <span
                  className={`w-1.5 h-1.5 rounded-full ${accent ? accent.dot : "bg-primary"} animate-pulse`}
                />
              )}
            </button>
          );
        })}
      </div>
      <CustomPresetSheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </>
  );
}
