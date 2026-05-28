/**
 * PM #57 — extracted from `moa.ts`. Role-aware tool assignment for MoA
 * proposers (PM #42 + PM #50) plus the success-predicate (PM #54).
 *
 * No I/O on import; the actual tool execution lives behind the SDK
 * `tool()` thunks. Pure import-time cost = the search-engine + code-
 * execution helpers' module-load (already transitively loaded by
 * runAgent anyway).
 *
 * Re-exported from `./moa` so test files keep their `import { ... }
 * from "./moa"` lines intact.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { AppSettings } from "@/lib/types";
import type { ProposerRole } from "@/lib/agent/moa-personas";
import { searchWeb } from "@/lib/tools/search-engine";
import { buildProposerCodeExecutionTool } from "@/lib/tools/code-execution";

// ── Proposer role + tool plumbing (PM #42) ──────────────────────────────
//
// Per-role tool assignment. Previously every proposer got `search_web` when
// search was enabled (blanket access) — a creative-brainstorming persona
// would have access to web search it never used, and the prompt didn't
// mandate verification, so fact-heavy personas often hallucinated library
// versions despite having the tool available.
//
// PM #42 splits this in two:
//   1. Role-aware tool selection — only reviewer/researcher personas get
//      `search_web`. Coder/tool/creative get no tools (focus on synthesis
//      from training data; cost stays bounded).
//   2. Prompt augmentation — personas that DO get search_web also get the
//      Fact-Check Mandate appended to their system prompt, telling them to
//      VERIFY library versions / API signatures / real-time facts BEFORE
//      drafting an answer.
//
// PM #50 extended this to give coder personas `code_execution` opt-in via
// `settings.codeExecution.proposerAccess`.

/**
 * Returns the tool set for this proposer's role.
 *   - reviewer / researcher → `search_web` (fact-checking depends on
 *     real-time external data; the Fact-Check Mandate stops them from
 *     hallucinating library versions).
 *   - coder → `code_execution` when both `settings.codeExecution.enabled`
 *     AND `settings.codeExecution.proposerAccess` are true (PM #50,
 *     opt-in). Lets the coder self-verify snippets before drafting.
 *   - everything else → `undefined`.
 *
 * A persona can get BOTH tools — e.g. if it has both reviewer and
 * coder keywords (rare; `detectProposerRole` returns a single role,
 * so in practice each persona gets one tool family).
 */
export function selectProposerTools(
  role: ProposerRole,
  searchEnabled: boolean,
  searchConfig: AppSettings["search"],
  coderContext?: {
    settings: AppSettings;
    cwd: string;
  }
): ToolSet | undefined {
  const out: ToolSet = {};

  if (searchEnabled && (role === "reviewer" || role === "researcher")) {
    out.search_web = tool({
      description: "Search the internet for real-time information, facts, and live data.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }, { abortSignal }) => {
        return searchWeb(query, 5, searchConfig, abortSignal);
      },
    });
  }

  // PM #50 — opt-in code_execution for coder personas. Gated on BOTH
  // the global enable flag (existing operator config) AND the new
  // per-proposer flag (the deferral from PM #42 demanded explicit
  // opt-in because each proposer × child process is a new failure
  // surface). The tool factory lives in code-execution.ts to avoid
  // pulling the orchestrator's full createAgentTools dependency tree
  // into moa.ts.
  if (
    role === "coder" &&
    coderContext &&
    coderContext.settings.codeExecution.enabled &&
    coderContext.settings.codeExecution.proposerAccess === true
  ) {
    out.code_execution = buildProposerCodeExecutionTool(
      coderContext.settings,
      coderContext.cwd
    );
  }

  if (Object.keys(out).length === 0) return undefined;
  return out;
}

/**
 * Fact-Check Mandate appended to a proposer's system prompt when it has
 * access to `search_web`. Without this, the LLM has the tool but no
 * instruction to use it for verification — proposers reliably hallucinated
 * library versions despite tool availability.
 */
export const FACT_CHECK_MANDATE = `

[FACT-CHECK MANDATE — you have access to search_web]
You MUST invoke the search_web tool BEFORE making any claim that depends on:
  - Library or framework versions (e.g., "Next.js 15", "React 19", "Tailwind v4")
  - API signatures, function names, or recent breaking changes
  - Real-time facts (news, prices, status, market data)
  - Specific URLs, package names, or model IDs the user provided

If you cannot verify a claim through search_web (rate-limited, no result, ambiguous), state that explicitly in your draft ("I could not verify X via search; this is my best understanding from training") rather than asserting it with false confidence.`;

/**
 * PM #50 — Mirror of FACT_CHECK_MANDATE for the code_execution tool.
 * Without an explicit instruction, the LLM has the tool but no reason
 * to use it — same failure mode as PM #42's pre-mandate search_web
 * (proposers hallucinated library versions despite tool availability).
 *
 * Verification triggers are scoped to coder work: type-checking,
 * API-signature confirmation, output-format validation, runtime
 * behavior of a snippet. NOT for: building products, running servers,
 * one-shot installs that produce no useful verification signal.
 */
export const CODE_EXECUTION_MANDATE = `

[CODE-EXECUTION MANDATE — you have access to code_execution]
You SHOULD invoke the code_execution tool BEFORE drafting code when:
  - A library API signature is uncertain (run a 2-line check to confirm).
  - The exact output shape of a function matters to the user's task.
  - A regex, parsing rule, or boundary condition needs empirical validation.
  - The user explicitly asked "will this work?" — run it and show them.

Do NOT use code_execution for: launching GUI apps, starting long-running
servers, infrastructure-mutating commands, or anything that doesn't exit
on its own. Your proposer turn has a 2-minute cap — keep snippets tight.

When verification succeeds, mention the verified fact concretely in your
draft. When it fails or times out, state that explicitly ("I tried X
via code_execution; it returned Y") rather than guessing.`;

export function augmentProposerPromptForTools(
  basePrompt: string,
  tools: ToolSet | undefined
): string {
  if (!tools) return basePrompt;
  let augmented = basePrompt;
  if ("search_web" in tools) augmented += FACT_CHECK_MANDATE;
  if ("code_execution" in tools) augmented += CODE_EXECUTION_MANDATE;
  return augmented;
}

/**
 * PM #54 — true success predicate for a proposer's draft text.
 * Excludes both the explicit `[Error: ...]` failure marker (proposer
 * threw) AND the `(empty draft)` placeholder (proposer returned empty).
 * Previously only `[Error:` was filtered, so an empty placeholder could
 * (a) land in the synthesis aggregator's prompt as if it were a real
 * draft and (b) win a tournament — the operator would see literal
 * "(empty draft)" as the assistant's final answer.
 *
 * Exported so the contract has its own focused test independent of the
 * runMoAEnsemble end-to-end mock setup.
 */
export function isSuccessfulDraft(text: string): boolean {
  if (text.startsWith("[Error:")) return false;
  if (text === "(empty draft)") return false;
  return true;
}
