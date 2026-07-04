"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/store/app-store";
import { useShallow } from "zustand/react/shallow";
import { ShieldQuestion } from "lucide-react";
import type { SkepticModelOverride } from "@/lib/agent/moa-personas";

/**
 * DDD — per-request Skeptic model selector for the swarm panel.
 *
 * The operator owns the Skeptic: this picks the exact model the reviewer
 * proposer AND the reflection critic run on, for the next turn onward
 * (global sticky panel state, like Force). It offers a fast switch between
 * models the operator has ALREADY configured (chat / utility / tier /
 * settings-skeptic) — arbitrary provider+model editing lives in
 * Settings → "Direct Skeptic Model". "Inherit Settings" clears the
 * per-request override so `proposerTiers.skeptic` (or the tier path) wins.
 *
 * Only `{provider, model}` ever leaves the client — the server re-validates
 * and resolves the API key (never trusts a client-supplied key/baseUrl).
 */

interface ModelRef {
  provider: string;
  model: string;
}

interface SettingsPayload {
  chatModel?: ModelRef;
  utilityModel?: ModelRef;
  proposerTiers?: {
    fast?: ModelRef;
    balanced?: ModelRef;
    frontier?: ModelRef;
    skeptic?: ModelRef;
  };
}

const INHERIT = "__inherit__";

function keyOf(m: ModelRef): string {
  return `${m.provider}/${m.model}`;
}

export function SkepticSelector() {
  const { skepticModelOverride, setSkepticModelOverride } = useAppStore(
    useShallow((s) => ({
      skepticModelOverride: s.skepticModelOverride,
      setSkepticModelOverride: s.setSkepticModelOverride,
    }))
  );

  const [candidates, setCandidates] = useState<ModelRef[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: SettingsPayload) => {
        if (cancelled) return;
        const raw: (ModelRef | undefined)[] = [
          data.chatModel,
          data.utilityModel,
          data.proposerTiers?.skeptic,
          data.proposerTiers?.frontier,
          data.proposerTiers?.balanced,
          data.proposerTiers?.fast,
        ];
        // Distinct, non-empty candidates preserving order.
        const seen = new Set<string>();
        const list: ModelRef[] = [];
        for (const m of raw) {
          if (!m?.provider || !m?.model) continue;
          const k = keyOf(m);
          if (seen.has(k)) continue;
          seen.add(k);
          list.push({ provider: m.provider, model: m.model });
        }
        setCandidates(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const currentValue = skepticModelOverride ? keyOf(skepticModelOverride) : INHERIT;

  // If the sticky override is a model no longer in the candidate list (e.g.
  // the operator removed it from settings), still show it so the state is
  // honest rather than silently snapping to "Inherit".
  const override = skepticModelOverride;
  const showOrphan =
    override != null && !candidates.some((c) => keyOf(c) === keyOf(override));

  function onChange(value: string) {
    if (value === INHERIT) {
      setSkepticModelOverride(null);
      return;
    }
    const [provider, ...rest] = value.split("/");
    const model = rest.join("/");
    if (!provider || !model) {
      setSkepticModelOverride(null);
      return;
    }
    // The provider originates from a server-validated candidate list; the API
    // route re-validates via `isValidSkepticOverride` (unknown provider → 400),
    // so this cast is safe — the server is the authoritative gate.
    const next: SkepticModelOverride = {
      provider: provider as SkepticModelOverride["provider"],
      model,
    };
    setSkepticModelOverride(next);
  }

  return (
    <label
      className="inline-flex items-center gap-1.5 h-8 pl-2.5 pr-1.5 rounded-lg border border-white/10 bg-white/[0.03] text-xs font-medium text-muted-foreground focus-within:ring-2 focus-within:ring-primary/40"
      title="Skeptic model — the reviewer proposer AND the reflection critic run on this model. 'Inherit' uses your Settings default. Applies to the next turn onward."
    >
      <ShieldQuestion className="w-3.5 h-3.5 shrink-0" />
      <span className="hidden md:inline-block">Skeptic</span>
      <select
        value={currentValue}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Skeptic model override"
        className="bg-transparent text-foreground/90 text-xs focus:outline-none max-w-[9rem] cursor-pointer"
      >
        <option value={INHERIT}>Inherit Settings</option>
        {candidates.map((c) => (
          <option key={keyOf(c)} value={keyOf(c)}>
            {c.provider}/{c.model}
          </option>
        ))}
        {showOrphan && override && (
          <option value={keyOf(override)}>
            {override.provider}/{override.model}
          </option>
        )}
      </select>
    </label>
  );
}
