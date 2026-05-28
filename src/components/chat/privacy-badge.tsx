"use client";

/**
 * Privacy Mode visual indicator (PM #47). Renders an inline pill in the
 * chat-panel header whenever `settings.privacyMode.enabled` is true.
 *
 * Why a badge: privacy is a state the operator can opt INTO, but easily
 * forgets they're IN. The legal/medical/gov-compliance threat model
 * means a single accidental turn-with-cloud-provider would violate the
 * promise. The badge is the at-a-glance reminder: every time the
 * operator looks at the chat, the pill confirms "yes, still air-gapped".
 *
 * Style: lock emoji + "Air-gapped" label, muted-but-visible. Friends
 * sharing the instance see it too and can ask "wait, is this private?"
 * before sending sensitive content.
 */
interface PrivacyBadgeProps {
  enabled: boolean | undefined;
}

export function PrivacyBadge({ enabled }: PrivacyBadgeProps) {
  if (!enabled) return null;
  return (
    <div
      role="status"
      aria-label="Privacy mode active — air-gapped from cloud providers"
      className="mx-auto max-w-3xl w-full px-4 md:px-6 pt-2 pb-1 text-[11px] flex items-center gap-2 select-none"
      title="Privacy Mode is ON. Orchestra will refuse any LLM call to a non-local backend (no OpenAI / Anthropic / Google / OpenRouter calls). To disable, edit settings.json or use the Settings UI."
    >
      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
        <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
        <span>🔒 Privacy mode — air-gapped (local backends only)</span>
      </span>
    </div>
  );
}
