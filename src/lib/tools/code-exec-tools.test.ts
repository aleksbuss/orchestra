import { describe, it, expect } from "vitest";
import type { ToolSet } from "ai";
import { createCodeExecTools } from "./code-exec-tools";
import type { AgentContext } from "@/lib/agent/types";
import type { AppSettings } from "@/lib/types";

/**
 * Tests for the code-execution tool FAMILY creator — the RCE surface's front
 * door. Two concerns are pinned here:
 *
 *   1. The PM #92 untrusted-trigger GATE (defense-in-depth). `tool.test.ts`
 *      already exercises this gate through the `createAgentTools` facade; these
 *      pin it DIRECTLY on `createCodeExecTools` so the property survives even if
 *      the facade's characterization changes. (Both were mutation-verified: a
 *      broken gate turns these red.)
 *   2. The kill-intent policy (`userExplicitlyRequestedProcessKill`, private) —
 *      previously UNtested. The agent may only stop a background process when
 *      the operator explicitly asked; this pins the intent + negation regex
 *      across EN and RU, including word-boundary false-positive guards.
 *
 * NOTE — threat-model boundary (deliberate NON-goals, not oversights): this
 * family runs code with the OPERATOR's own privileges by design. There is NO
 * in-process confinement here — no PATH jail, no network block, no filesystem
 * sandbox, no rlimit/process-group containment. Containment is the OPT-IN
 * Docker story (CLAUDE.md §6). The tests below therefore assert AVAILABILITY /
 * POLICY, never confinement.
 */

function ctx(over: Partial<AgentContext> = {}): AgentContext {
  return {
    chatId: "c1",
    memorySubdir: "main",
    knowledgeSubdirs: [],
    history: [],
    agentNumber: 0,
    data: {},
    ...over,
  } as AgentContext;
}

function settings(codeExecution: Record<string, unknown>): AppSettings {
  return { codeExecution } as unknown as AppSettings;
}

const FAMILY = ["code_execution", "install_packages", "process"] as const;
const hasFamily = (t: ToolSet) => FAMILY.every((n) => n in t);
const hasNoFamily = (t: ToolSet) => FAMILY.every((n) => !(n in t));

describe("createCodeExecTools — PM #92 untrusted-trigger gate (direct)", () => {
  it("withholds the whole family when codeExecution.enabled is false", () => {
    expect(hasNoFamily(createCodeExecTools(ctx(), settings({ enabled: false })))).toBe(true);
  });

  it("withholds the family from an UNTRUSTED trigger by default (the PM #92 RCE gate)", () => {
    const tools = createCodeExecTools(
      ctx({ untrustedTrigger: true }),
      settings({ enabled: true })
    );
    expect(hasNoFamily(tools)).toBe(true);
  });

  it("re-enables the family for an untrusted trigger only when allowExternalTriggers is set", () => {
    const tools = createCodeExecTools(
      ctx({ untrustedTrigger: true }),
      settings({ enabled: true, allowExternalTriggers: true })
    );
    expect(hasFamily(tools)).toBe(true);
  });

  it("leaves the family intact for a trusted (operator/cron) trigger", () => {
    expect(hasFamily(createCodeExecTools(ctx({ untrustedTrigger: undefined }), settings({ enabled: true })))).toBe(true);
    expect(hasFamily(createCodeExecTools(ctx({ untrustedTrigger: false }), settings({ enabled: true })))).toBe(true);
  });
});

describe("createCodeExecTools — kill-intent policy (process action:kill)", () => {
  // Invoke the process tool's kill action with a given user message. When the
  // policy BLOCKS, the result is the deterministic "Kill blocked by policy"
  // refusal — reached BEFORE killManagedProcessSession, so no real session is
  // needed. When the policy ALLOWS, control passes through to the killer, which
  // returns status "not_found" for an unknown id — i.e. NOT the policy block.
  async function killResult(userMessage: string | undefined) {
    const tools = createCodeExecTools(
      ctx({ data: userMessage === undefined ? {} : { currentUserMessage: userMessage } }),
      settings({ enabled: true })
    );
    const proc = tools.process as unknown as { execute: (a: unknown) => Promise<unknown> };
    return (await proc.execute({ action: "kill", session_id: "no-such-session" })) as {
      success?: boolean;
      error?: string;
      status?: string;
    };
  }
  const blocked = (r: { error?: string }) => (r.error ?? "").includes("Kill blocked by policy");

  it("BLOCKS a kill with no explicit user intent", async () => {
    expect(blocked(await killResult("how is the build going?"))).toBe(true);
  });

  it("BLOCKS a kill when the user message is empty/absent", async () => {
    expect(blocked(await killResult(""))).toBe(true);
    expect(blocked(await killResult(undefined))).toBe(true);
  });

  it("ALLOWS a kill on explicit EN intent ('stop it')", async () => {
    const r = await killResult("please stop the running process");
    expect(blocked(r)).toBe(false);
    expect(r.status).toBe("not_found"); // passed the policy, reached the killer
  });

  it("ALLOWS a kill on explicit RU intent (regression: ASCII \\b never matched Cyrillic)", async () => {
    // Every one of these returned "blocked" before the Unicode-boundary fix,
    // because JS `\b` is ASCII-only — the RU verb list was dead code and a
    // Russian operator could not stop a background process by asking in Russian.
    expect(blocked(await killResult("останови процесс немедленно"))).toBe(false);
    expect(blocked(await killResult("убей сессию"))).toBe(false);
    expect(blocked(await killResult("прерви выполнение"))).toBe(false);
    expect(blocked(await killResult("заверши задачу пожалуйста"))).toBe(false);
  });

  it("does NOT treat 'нет' as a kill/negation trigger (Cyrillic word-boundary)", async () => {
    // "нет" contains "не" but must not fire the negation branch as a bare word,
    // and carries no kill intent → a plain block for lack of intent, not a match.
    expect(blocked(await killResult("нет проблем, продолжай работу"))).toBe(true);
  });

  it("BLOCKS a negated EN intent (\"don't stop it\")", async () => {
    expect(blocked(await killResult("do not stop the process, let it finish"))).toBe(true);
  });

  it("BLOCKS a negated RU intent ('не прерывай')", async () => {
    expect(blocked(await killResult("не прерывай выполнение"))).toBe(true);
  });

  it("does NOT false-match 'end' inside a word ('weekend')", async () => {
    // \bend\b must not fire on "weekend" — a word-boundary regression here would
    // let the agent kill a process on an unrelated message.
    expect(blocked(await killResult("deploy the weekend release build"))).toBe(true);
  });

  it("requires a session_id for kill", async () => {
    const tools = createCodeExecTools(
      ctx({ data: { currentUserMessage: "stop it" } }),
      settings({ enabled: true })
    );
    const proc = tools.process as unknown as { execute: (a: unknown) => Promise<unknown> };
    const r = (await proc.execute({ action: "kill" })) as { success?: boolean; error?: string };
    expect(r.success).toBe(false);
    expect(r.error).toContain("session_id is required");
  });
});
