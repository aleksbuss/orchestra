"use client";

/**
 * Visual surface for structured chat errors emitted by the agent.
 *
 * The backend (Sprint 3 / PM #17 follow-up) publishes `chat-error` events
 * with `{traceId, kind, message, hint, recoverable}` whenever a turn fails
 * after MoA. This component renders the latest error inline above the
 * chat input, color-coded by `kind` so the user can tell "wait and retry"
 * (rate-limit, 5xx) from "fix something in Settings" (no_tools, 4xx) at a
 * glance.
 *
 * Why this lives next to the chat panel and not in `components/ui/`:
 * the only consumer is the chat panel, the data shape comes from the
 * realtime bus, and the styling intentionally matches the Auto-Pilot
 * toast pattern that already lives here. A future second consumer would
 * be a fine reason to promote it to `components/ui/` later.
 */
import { AlertTriangle, Copy, X, RefreshCw } from "lucide-react";
import { useState } from "react";
import type {
  ChatErrorKind,
  ChatErrorPayload,
} from "@/lib/realtime/types";

interface BannerStyle {
  /** Tailwind classes for the outer pill. Includes background + border + text. */
  container: string;
  /** Tailwind class for the icon color. */
  icon: string;
  /** Short label rendered before the message ("Error", "Rate limited", etc.). */
  label: string;
}

/**
 * Map a `ChatErrorKind` to its visual treatment.
 *
 * Exported as a pure function so the styling logic is unit-testable
 * without rendering React. The component is then a thin shell over this
 * decision + the payload props.
 */
export function styleForKind(kind: ChatErrorKind): BannerStyle {
  switch (kind) {
    case "model_fallback":
      // INFO-level, not error. The agent already auto-switched models;
      // user just needs to know. Emerald to read as "system recovered"
      // rather than "something broke".
      return {
        container: "bg-emerald-500/10 border-emerald-500/20 text-emerald-200",
        icon: "text-emerald-400",
        label: "Switched model",
      };
    case "upstream_no_tools":
      // Actionable — user MUST switch model. Amber draws attention without
      // alarming as much as red, since the system isn't broken, just
      // misconfigured.
      return {
        container: "bg-amber-500/10 border-amber-500/20 text-amber-200",
        icon: "text-amber-400",
        label: "Model can't call tools",
      };
    case "upstream_rate_limit":
      return {
        container: "bg-amber-500/10 border-amber-500/20 text-amber-200",
        icon: "text-amber-400",
        label: "Rate limited",
      };
    case "upstream_5xx":
      return {
        container: "bg-amber-500/10 border-amber-500/20 text-amber-200",
        icon: "text-amber-400",
        label: "Provider unavailable",
      };
    case "upstream_4xx":
      return {
        container: "bg-red-500/10 border-red-500/20 text-red-200",
        icon: "text-red-400",
        label: "Provider rejected the request",
      };
    case "abort":
      // User cancelled — neutral, not an error condition. Render at all
      // mostly for transparency: the user knows their stop button worked.
      return {
        container: "bg-slate-500/10 border-slate-500/20 text-slate-300",
        icon: "text-slate-400",
        label: "Request cancelled",
      };
    case "internal":
    default:
      return {
        container: "bg-red-500/10 border-red-500/20 text-red-200",
        icon: "text-red-400",
        label: "Internal error",
      };
  }
}

interface ChatErrorBannerProps {
  error: ChatErrorPayload;
  onDismiss: () => void;
}

export function ChatErrorBanner({ error, onDismiss }: ChatErrorBannerProps) {
  const style = styleForKind(error.kind);
  const [copied, setCopied] = useState(false);

  const handleCopyTrace = async () => {
    if (!error.traceId) return;
    try {
      await navigator.clipboard.writeText(error.traceId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can fail in insecure contexts / some browsers.
      // No fallback needed here — the trace id is also visible in the DOM.
    }
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="mx-auto max-w-3xl w-full px-6 pt-2 animate-in fade-in slide-in-from-top-2 duration-300"
    >
      <div className={`flex items-start gap-3 rounded-xl border px-4 py-2.5 ${style.container}`}>
        <div className="flex items-center justify-center size-7 rounded-full bg-current/10 shrink-0 mt-0.5">
          {error.kind === "model_fallback" ? (
            <RefreshCw className={`size-3.5 ${style.icon}`} />
          ) : (
            <AlertTriangle className={`size-3.5 ${style.icon}`} />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium leading-snug">{style.label}</p>
          <p className="text-xs opacity-80 leading-snug mt-0.5">{error.message}</p>
          {error.hint && (
            <p className="text-xs opacity-70 leading-snug mt-1.5 italic">{error.hint}</p>
          )}
          {error.traceId && (
            <button
              type="button"
              onClick={handleCopyTrace}
              className="mt-2 inline-flex items-center gap-1.5 text-[10px] opacity-60 hover:opacity-90 transition-opacity font-mono"
              title="Copy trace id for the server log"
            >
              <Copy className="size-3" />
              {copied ? "copied" : `trace ${error.traceId.slice(0, 8)}`}
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 opacity-50 hover:opacity-100 transition-opacity"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
