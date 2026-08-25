/**
 * Orchestra Model Presets (Bundles) - LEGACY / DEPRECATED
 * 
 * Note: Built-in presets (Prime, Core, etc.) have been removed. 
 * The application now uses the global chatModel configuration.
 */

import type { ModelConfig } from "@/lib/types";

export type PresetTier = "custom";

export interface ModelPreset {
  tier: PresetTier;
  label: string;
  subtitle: string;
  description: string;
  accentColor: string;
  icon: string;
  brain: ModelConfig;
  worker: ModelConfig;
}

export const PRESETS: Record<string, ModelPreset> = {};

// `getPreset()` used to live here. It returned `null` unconditionally and was
// referenced by nothing — one occurrence in the whole tree, its own declaration.

export function getBrainConfig(_tier: string, fallback: ModelConfig): ModelConfig {
  return fallback;
}

export function getWorkerConfig(_tier: string, fallback: ModelConfig): ModelConfig {
  return fallback;
}

export const PRESET_ORDER: PresetTier[] = ["custom"];
