/**
 * Unit coverage for `styleForKind` — the kind→tailwind mapping that drives
 * the banner's color treatment. Tests live here (not in a `*.test.tsx` next
 * to React) because we don't have @testing-library/react / jsdom in the
 * vitest environment yet — promoting them is a separate Sprint.
 *
 * Pinned invariants:
 *   - Every `ChatErrorKind` returns a non-empty container, icon, label.
 *   - Recoverable kinds (rate_limit, 5xx) and the actionable
 *     `upstream_no_tools` use amber, not red — the user shouldn't get a
 *     "everything is broken" red flash for "wait 5s and retry."
 *   - Hard-fail kinds (internal, upstream_4xx) get red.
 *   - `abort` is muted slate — it was a user action, not an error
 *     condition.
 *   - The default branch handles forward compatibility: a future
 *     `ChatErrorKind` added to types.ts but not yet handled here returns
 *     the conservative red treatment instead of an empty/missing banner.
 */
import { describe, it, expect } from "vitest";
import { styleForKind } from "./chat-error-banner";
import type { ChatErrorKind } from "@/lib/realtime/types";

const ALL_KINDS: ChatErrorKind[] = [
  "upstream_no_tools",
  "upstream_rate_limit",
  "upstream_4xx",
  "upstream_5xx",
  "abort",
  "internal",
];

describe("styleForKind — every kind has a complete style", () => {
  it.each(ALL_KINDS)("returns non-empty container/icon/label for kind=%s", (kind) => {
    const style = styleForKind(kind);
    expect(style.container.length).toBeGreaterThan(0);
    expect(style.icon.length).toBeGreaterThan(0);
    expect(style.label.length).toBeGreaterThan(0);
  });
});

describe("styleForKind — color semantics", () => {
  it("amber for recoverable / actionable kinds (no panic red)", () => {
    expect(styleForKind("upstream_rate_limit").container).toContain("amber");
    expect(styleForKind("upstream_5xx").container).toContain("amber");
    // `upstream_no_tools` is actionable (switch model) but the system isn't
    // broken — amber communicates that.
    expect(styleForKind("upstream_no_tools").container).toContain("amber");
  });

  it("red for hard-fail kinds (4xx, internal)", () => {
    expect(styleForKind("upstream_4xx").container).toContain("red");
    expect(styleForKind("internal").container).toContain("red");
  });

  it("slate (muted) for abort — user-initiated, not a system error", () => {
    expect(styleForKind("abort").container).toContain("slate");
  });
});

describe("styleForKind — forward-compat default branch", () => {
  it("returns the internal-error treatment for an unknown kind (defensive)", () => {
    // Cast through `unknown` — TypeScript would reject the literal otherwise,
    // but at runtime a future `ChatErrorKind` added to `types.ts` without
    // updating the switch will land here.
    const futureKind = "future_unknown" as unknown as ChatErrorKind;
    const style = styleForKind(futureKind);
    expect(style.container).toContain("red");
    expect(style.label).toMatch(/internal/i);
  });
});

describe("styleForKind — labels are user-facing copy", () => {
  it("labels do not leak internal jargon — should read like UI strings", () => {
    // Labels render directly in the toast, not for developer eyes. They
    // shouldn't contain status codes, error class names, or stack hints.
    for (const kind of ALL_KINDS) {
      const { label } = styleForKind(kind);
      expect(label, `kind=${kind} label="${label}" must not leak internals`)
        .not.toMatch(/AI_APICallError|stack|trace|err\b|exception/i);
    }
  });
});
