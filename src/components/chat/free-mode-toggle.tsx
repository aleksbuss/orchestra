"use client";

import { useEffect, useState, useCallback } from "react";
import { Leaf } from "lucide-react";

/**
 * Free Mode pill.
 *
 * Unlike its neighbours (Swarm / Force / Deep Audit), Free Mode is NOT a
 * per-turn flag: it changes which MODELS run, and it has to hold for cron
 * ticks, Auto-Pilot continuations and external-message turns that no browser
 * is watching. So it lives in settings and is patched over the API rather than
 * pushed through the request body.
 *
 * Reads once on mount and re-reads on the global settings broadcast, so a
 * second tab (or the Settings screen) flipping it does not leave this pill
 * stale — `PATCH /api/settings` publishes a `global` UI-sync event for exactly
 * this reason.
 */
const PILL_BASE =
  "inline-flex shrink-0 items-center gap-2 h-8 px-3 rounded-lg border text-xs font-medium " +
  "whitespace-nowrap transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2";

const PILL_IDLE =
  "bg-foreground/[0.03] border-border/70 text-muted-foreground " +
  "hover:bg-foreground/[0.06] hover:text-foreground";

export function FreeModeToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) return;
      const s = (await res.json()) as { freeMode?: { enabled?: boolean } };
      setEnabled(s.freeMode?.enabled === true);
    } catch {
      // A failed read leaves the pill in its last known state rather than
      // asserting "off" — claiming Free Mode is off when it is on would send
      // the user hunting for why a model they did not pick is answering.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async () => {
    if (busy || enabled === null) return;
    const next = !enabled;
    setBusy(true);
    setEnabled(next); // optimistic
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "freeMode.enabled", value: next }),
      });
      if (!res.ok) setEnabled(!next); // roll back — the server is the truth
    } catch {
      setEnabled(!next);
    } finally {
      setBusy(false);
    }
  };

  const on = enabled === true;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      aria-label="Toggle Free Mode — run on free OpenRouter models"
      disabled={enabled === null || busy}
      title={
        on
          ? "Free Mode is ON: Orchestra picks free OpenRouter models for you (brain, Router and each proposer tier on separate endpoints) and the free-tier failover stack is active. You configure nothing. Slower, models may switch, quality may vary."
          : "Free Mode is OFF: your own configured models run. Turn it on to work entirely on free OpenRouter endpoints with no configuration."
      }
      className={`${PILL_BASE} focus-visible:ring-emerald-500/40 disabled:opacity-60
        ${on
          ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
          : PILL_IDLE
        }
      `}
    >
      <Leaf className="w-3.5 h-3.5" />
      <span>Free</span>
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          on ? "bg-emerald-500 dark:bg-emerald-400 animate-pulse" : "bg-muted-foreground/30"
        }`}
      />
    </button>
  );
}
