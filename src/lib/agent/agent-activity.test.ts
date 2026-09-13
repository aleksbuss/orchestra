/**
 * Tests for the recovery activity feed.
 *
 * The property that matters most here is NEGATIVE: this module must be
 * incapable of forwarding model- or upstream-authored text to a browser. Two
 * tests enforce it — one on the interface's shape (a source scan, so adding
 * `detail?: string` fails the build rather than a review), one on the rendered
 * output of every code. The rest is ordinary behaviour.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  renderAgentActivity,
  publishAgentActivity,
  activityReporter,
  type AgentActivityCode,
  type AgentActivityFields,
  type RecoveryAbortPhase,
} from "@/lib/agent/agent-activity";
import { subscribeUiSyncEvents } from "@/lib/realtime/event-bus";
import type { UiSyncEvent } from "@/lib/realtime/types";
import type { ModelConfig } from "@/lib/types";

const ALL_CODES: AgentActivityCode[] = [
  "cascade_started",
  "cascade_started_markup",
  "brain_circuit_open",
  "brain_retry_skipped_markup",
  "brain_retry_skipped_nontransient",
  "substitute_trying",
  "substitute_build_failed",
  "substitute_delivered",
  "cascade_budget_exhausted",
  "cascade_all_breakers_open",
  "cascade_substitution_not_allowed",
  "cascade_exhausted",
  "recovery_aborted",
];

const ALL_PHASES: RecoveryAbortPhase[] = [
  "brain_attempt_1",
  "brain_retry_backoff",
  "brain_attempt_2",
  "before_substitute",
  "after_substitute",
];

const brain: ModelConfig = { provider: "openrouter", model: "nvidia/nemotron-3-ultra:free" };
const sub: ModelConfig = { provider: "openrouter", model: "cohere/north-mini-code:free" };

function capture(fn: () => void): UiSyncEvent[] {
  const seen: UiSyncEvent[] = [];
  const unsubscribe = subscribeUiSyncEvents((e) => seen.push(e));
  try {
    fn();
  } finally {
    unsubscribe();
  }
  return seen;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderAgentActivity — every code renders", () => {
  it.each(ALL_CODES)("%s produces non-empty operator text", (code) => {
    const text = renderAgentActivity(code, {
      endpoint: brain,
      substitute: sub,
      attempt: 2,
      candidateCount: 4,
      remainingCount: 2,
      budgetMs: 50_000,
      attemptDeadlineMs: 25_000,
      policy: "speed",
      markupChars: 289,
      phase: "after_substitute",
      elapsedMs: 43_217,
    });
    expect(text.length).toBeGreaterThan(0);
    expect(text.startsWith("[Failover] ")).toBe(true);
    // A template that forgot a substitution ships `undefined` to the operator.
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("[object Object]");
  });

  it("renders every abort phase distinctly", () => {
    const rendered = ALL_PHASES.map((phase) =>
      renderAgentActivity("recovery_aborted", { phase, elapsedMs: 1_000 })
    );
    expect(new Set(rendered).size).toBe(ALL_PHASES.length);
  });

  it("with NO fields at all, still renders without leaking placeholders", () => {
    for (const code of ALL_CODES) {
      const text = renderAgentActivity(code);
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("NaN");
    }
  });
});

describe("renderAgentActivity — the redaction boundary", () => {
  it("identifies an endpoint as provider/model and nothing more", () => {
    const text = renderAgentActivity("brain_circuit_open", { endpoint: brain });
    expect(text).toContain("openrouter/nvidia/nemotron-3-ultra:free");
  });

  it("names a neutral noun when the slot was never configured", () => {
    expect(renderAgentActivity("brain_circuit_open")).toContain("the configured model");
  });

  it("reports markup as a COUNT, never as the markup itself", () => {
    const text = renderAgentActivity("cascade_started_markup", {
      endpoint: brain,
      markupChars: 289,
      budgetMs: 30_000,
      attemptDeadlineMs: 15_000,
    });
    expect(text).toContain("289 characters");
    expect(text).not.toContain("<tool_call>");
  });

  it("an API key sitting on the ModelConfig is never rendered", () => {
    const withKey: ModelConfig = { ...brain, apiKey: "sk-or-v1-SHOULD-NOT-APPEAR" };
    for (const code of ALL_CODES) {
      const text = renderAgentActivity(code, { endpoint: withKey, substitute: withKey });
      expect(text).not.toContain("SHOULD-NOT-APPEAR");
      expect(text).not.toContain("sk-or-v1");
    }
  });

  /**
   * The structural guarantee. `AgentActivityFields` must expose no bare
   * `string` member: that is what makes it impossible for a call site to pass
   * an upstream `error.message` or a model-printed tool name through to an SSE
   * frame. Adding `detail?: string` should fail HERE, not in review.
   */
  it("AgentActivityFields declares no free-form string member", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/lib/agent/agent-activity.ts"),
      "utf-8"
    );
    const start = source.indexOf("export interface AgentActivityFields {");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));
    const withoutComments = body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const offenders = withoutComments
      .split("\n")
      .filter((line) => /^\s*\w+\??:\s*string\s*;/.test(line));
    expect(offenders).toEqual([]);
  });
});

describe("duration and count formatting", () => {
  it("sub-second elapsed renders in milliseconds", () => {
    expect(renderAgentActivity("cascade_exhausted", { elapsedMs: 820 })).toContain("820ms");
  });

  it("multi-second elapsed renders in seconds with one decimal", () => {
    expect(renderAgentActivity("cascade_exhausted", { elapsedMs: 43_217 })).toContain("43.2s");
  });

  it("a missing duration says so instead of printing undefined", () => {
    expect(renderAgentActivity("cascade_exhausted", {})).toContain("unknown time");
  });

  it("a NaN count renders as 0, not NaN", () => {
    const text = renderAgentActivity("cascade_all_breakers_open", {
      endpoint: brain,
      candidateCount: Number.NaN,
    });
    expect(text).toContain("all 0 substitute");
  });

  it("a fractional count is truncated", () => {
    expect(
      renderAgentActivity("substitute_trying", { substitute: sub, attempt: 2.9, candidateCount: 4 })
    ).toContain("candidate 2 of 4");
  });
});

describe("publishAgentActivity", () => {
  it("publishes one chat-scoped event whose reason is the rendered text", () => {
    const events = capture(() =>
      publishAgentActivity(
        { chatId: "chat-1", projectId: "proj-1" },
        "substitute_delivered",
        { substitute: sub, elapsedMs: 12_000 }
      )
    );
    expect(events).toHaveLength(1);
    expect(events[0].topic).toBe("chat");
    expect(events[0].chatId).toBe("chat-1");
    expect(events[0].projectId).toBe("proj-1");
    expect(events[0].reason).toBe(
      renderAgentActivity("substitute_delivered", { substitute: sub, elapsedMs: 12_000 })
    );
  });

  it("is a no-op without a chatId — an unscoped event could reach no pane", () => {
    const events = capture(() => publishAgentActivity({}, "cascade_exhausted"));
    expect(events).toHaveLength(0);
  });

  it("normalizes a missing projectId to null rather than undefined", () => {
    const events = capture(() => publishAgentActivity({ chatId: "c" }, "cascade_exhausted"));
    expect(events[0].projectId).toBeNull();
  });

  /**
   * Two different guarantees, and the first cut conflated them — mutation
   * testing caught it. A throwing LISTENER is already swallowed by the bus
   * (`event-bus.ts`), so a test that only registers one proves nothing about
   * this module: deleting the try/catch here left it green. This pair pins
   * both halves, and the second one dies if the guard is removed.
   */
  it("a throwing listener is contained by the bus, not by us", () => {
    const listener = subscribeUiSyncEvents(() => {
      throw new Error("listener exploded");
    });
    try {
      expect(() =>
        publishAgentActivity({ chatId: "c" }, "cascade_exhausted")
      ).not.toThrow();
    } finally {
      listener();
    }
  });

  it("a throwing PUBLISH is contained here — a degraded turn must not get worse", async () => {
    vi.resetModules();
    vi.doMock("@/lib/realtime/event-bus", () => ({
      publishUiSyncEvent: () => {
        throw new Error("bus exploded");
      },
      subscribeUiSyncEvents: () => () => {},
    }));
    const mod = await import("@/lib/agent/agent-activity");
    expect(() => mod.publishAgentActivity({ chatId: "c" }, "cascade_exhausted")).not.toThrow();
    vi.doUnmock("@/lib/realtime/event-bus");
    vi.resetModules();
  });
});

describe("activityReporter", () => {
  it("stamps elapsedMs from the bound start instant", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(5_000);
    const say = activityReporter({ chatId: "c" }, 1_000);
    now.mockReturnValue(9_000);
    const events = capture(() => say("cascade_exhausted"));
    // 9000 - 1000 = 8000ms => "8.0s"
    expect(events[0].reason).toContain("8.0s");
  });

  it("an explicitly supplied elapsedMs wins over the stamp", () => {
    const say = activityReporter({ chatId: "c" }, 0);
    const events = capture(() => say("cascade_exhausted", { elapsedMs: 1_500 }));
    expect(events[0].reason).toContain("1.5s");
  });

  it("carries the bound chatId and projectId onto every event", () => {
    const say = activityReporter({ chatId: "c9", projectId: "p9" }, Date.now());
    const events = capture(() => {
      say("cascade_started", { endpoint: brain, budgetMs: 50_000, attemptDeadlineMs: 25_000 });
      say("substitute_trying", { substitute: sub, attempt: 1, candidateCount: 3 });
    });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.chatId === "c9" && e.projectId === "p9")).toBe(true);
  });
});

describe("field typing is exhaustive over what the ladder reports", () => {
  it("accepts the full field set the cascade populates", () => {
    const fields: AgentActivityFields = {
      endpoint: brain,
      substitute: sub,
      attempt: 1,
      candidateCount: 3,
      remainingCount: 2,
      budgetMs: 50_000,
      attemptDeadlineMs: 25_000,
      policy: "quality",
      markupChars: 40,
      phase: "before_substitute",
      elapsedMs: 100,
    };
    expect(renderAgentActivity("cascade_started", fields)).toContain("50.0s");
  });
});
