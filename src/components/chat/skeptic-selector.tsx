"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/store/app-store";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, ShieldQuestion } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SkepticModelFields } from "@/components/settings/model-wizards";
import type { SkepticModelOverride } from "@/lib/agent/moa-personas";
import type { AppSettings } from "@/lib/types";

/**
 * DDD — per-request Skeptic model selector for the swarm panel.
 *
 * The operator owns the Skeptic: this picks the exact model the reviewer
 * proposer AND the reflection critic run on, for the next turn onward (global
 * sticky panel state, like Force). Unlike the earlier version — which only
 * offered a quick-switch among ALREADY-configured models — this now exposes the
 * SAME provider + searchable-catalog picker as the orchestrator wizard
 * (`SkepticModelFields`), so any model of any accepted provider can be selected
 * and tested as the Skeptic without first wiring it up elsewhere in Settings.
 *
 * Only `{provider, model}` ever leaves the client — the server re-validates
 * (`isValidSkepticOverride`) and resolves the API key (never trusts a
 * client-supplied key/baseUrl). "Inherit Settings" clears the per-request
 * override so `proposerTiers.skeptic` (or the tier path) wins.
 *
 * The panel renders through a portalled Radix Popover: the pill lives inside
 * the header's horizontally-scrollable strip, and an absolutely-positioned
 * dropdown would be clipped by that scroll container.
 */

const DEFAULT_PROVIDER = "openrouter";

export function SkepticSelector() {
  const { skepticModelOverride, setSkepticModelOverride } = useAppStore(
    useShallow((s) => ({
      skepticModelOverride: s.skepticModelOverride,
      setSkepticModelOverride: s.setSkepticModelOverride,
    }))
  );

  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // `true` once the settings fetch has failed (network error or non-2xx). Kept
  // separate from `settings === null` so the picker can render an error state
  // with a retry instead of an indefinite "Loading…" (a swallowed `.catch`
  // used to strand the panel forever on any fetch failure).
  const [settingsError, setSettingsError] = useState(false);
  // Bump to re-run the settings fetch (the "Retry" affordance).
  const [reloadTick, setReloadTick] = useState(0);
  // Provider held while the operator is mid-selection (before a model is
  // chosen). Seeded from the sticky override so re-opening shows its provider.
  const [draftProvider, setDraftProvider] = useState<string>(DEFAULT_PROVIDER);

  useEffect(() => {
    if (skepticModelOverride?.provider) setDraftProvider(skepticModelOverride.provider);
  }, [skepticModelOverride]);

  // Fetch the full (masked) settings so the picker can list catalogs.
  // Keys are masked here; `forceFetch` lets `/api/models` resolve them server-side.
  // A non-2xx response throws (so a JSON error body isn't mistaken for settings),
  // and any failure flips `settingsError` instead of being silently swallowed.
  useEffect(() => {
    let cancelled = false;
    setSettingsError(false);
    fetch("/api/settings")
      .then((r) => {
        if (!r.ok) throw new Error(`settings fetch failed: ${r.status}`);
        return r.json();
      })
      .then((data: AppSettings) => {
        if (!cancelled) setSettings(data);
      })
      .catch(() => {
        if (!cancelled) setSettingsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  function handleChange(provider: string, model: string) {
    setDraftProvider(provider);
    if (model) {
      setSkepticModelOverride({
        provider: provider as SkepticModelOverride["provider"],
        model,
      });
    } else {
      // Provider switched before a model was picked — drop any stale override
      // so we never keep a model that belongs to a different provider.
      setSkepticModelOverride(null);
    }
  }

  const label = skepticModelOverride
    ? `${skepticModelOverride.provider}/${skepticModelOverride.model}`
    : "Inherit";

  const currentProvider = skepticModelOverride?.provider ?? draftProvider;
  const currentModel = skepticModelOverride?.model ?? "";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Skeptic model override"
          title="Skeptic model — the reviewer proposer AND the reflection critic run on this model. 'Inherit' uses your Settings default. Applies to the next turn onward."
          className="inline-flex shrink-0 items-center gap-1.5 h-8 pl-2.5 pr-2 rounded-lg border border-border/70 bg-foreground/[0.03] text-xs font-medium whitespace-nowrap text-muted-foreground hover:bg-foreground/[0.06] focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          <ShieldQuestion className="w-3.5 h-3.5 shrink-0" />
          <span className="hidden md:inline-block">Skeptic</span>
          <span className="max-w-[9rem] truncate text-foreground/90">{label}</span>
          <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[22rem] max-w-[90vw]">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Skeptic model (next turn onward)</span>
          <button
            type="button"
            onClick={() => {
              setSkepticModelOverride(null);
              setOpen(false);
            }}
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            Inherit Settings
          </button>
        </div>
        {settings ? (
          <SkepticModelFields
            settings={settings}
            provider={currentProvider}
            model={currentModel}
            onChange={handleChange}
            forceFetch
          />
        ) : settingsError ? (
          <div className="py-4 text-center text-xs text-muted-foreground">
            <span className="text-destructive">Couldn&apos;t load models.</span>{" "}
            <button
              type="button"
              onClick={() => setReloadTick((t) => t + 1)}
              className="underline hover:text-foreground"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="py-4 text-center text-xs text-muted-foreground">Loading…</div>
        )}
      </PopoverContent>
    </Popover>
  );
}
