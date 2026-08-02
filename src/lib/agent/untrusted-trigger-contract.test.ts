/**
 * Structural CI gate for the untrusted-trigger capability contract (PM #92).
 *
 * WHY THIS EXISTS: an external message (Telegram relay / external-API POST)
 * runs the agent with `AgentContext.untrustedTrigger = true`, which withholds
 * the RCE-class tool family (`code_execution` / `install_packages` / `process`)
 * and the whole MCP surface. The gate at the *consumer* end is well tested
 * (`code-exec-tools.test.ts`, `mcp/client.test.ts`). What was NOT tested is the
 * part the rule actually warns about:
 *
 *   "thread the trust flag through EVERY delegated run — a gate bypassable by
 *    one `call_subordinate` hop is theater"
 *
 * The flag travels by hand through four hops — `tool.ts` passes
 * `context.untrustedTrigger` as a POSITIONAL argument to `callSubordinate`,
 * which forwards it to `runSubordinateAgent`, which writes it into the
 * subordinate's fresh `AgentContext`, which the tool gates then read. Every one
 * of those is a plain parameter a refactor can silently drop: reorder the
 * positional args in `tool.ts` and the flag becomes `undefined`, the subordinate
 * rebuilds a FULL toolset, and an untrusted external user reaches the host shell.
 * Nothing would fail — not the type checker (the parameter is optional by
 * design, so a trusted caller may omit it), not any existing test.
 *
 * A cross-model review of the CLAUDE.md Level 1 / Level 2 split flagged the
 * asymmetry that motivated this file: "no `new EventSource` in a component" has
 * a tree-wide structural gate, while the privilege-escalation path has none.
 *
 * WHAT IT GATES (all structural, in the shape of `abort-contract.test.ts` and
 * `agent-preflight-gate.test.ts` — scan the tree, never a hardcoded file list):
 *   1. Every CALL to a delegation entry point forwards `untrustedTrigger`.
 *   2. The untrusted ENTRY point still sets it (otherwise 1 is vacuous).
 *   3. The CONSUMERS still read it (otherwise 1 and 2 are vacuous).
 * Plus one behavioural test that the `callSubordinate` -> `runSubordinateAgent`
 * hop really carries the value, so the structural scan cannot pass on a call
 * that merely mentions the identifier in a comment.
 *
 * DELIBERATELY NOT GATED: whether a given entry point *should* be untrusted.
 * Cron is trusted on purpose (it leaves the flag undefined) and the interactive
 * `runAgent` is the operator's own session. Asserting "every runAgent-like call
 * passes the flag" would be wrong, not stricter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src/lib", "src/app"];

/**
 * A CALL to one of the delegation entry points — not its declaration. The
 * negative lookbehind on `function ` keeps the two `export async function`
 * definitions out of the scan, and `\b` keeps `callSubordinateFoo(` out.
 */
const DELEGATION_CALL = /(?<!function\s)\b(callSubordinate|runSubordinateAgent)\s*\(/;

/** Where the trust decision is made for external (untrusted) traffic. */
const UNTRUSTED_ENTRY = "src/lib/external/handle-external-message.ts";

/** The capability gates that consume the flag. Both must keep reading it. */
const CONSUMERS = ["src/lib/tools/code-exec-tools.ts", "src/lib/mcp/client.ts"];

interface Finding {
  file: string;
  line: number;
  callee: string;
}

/**
 * Bracket-balanced scan, same mechanism as the PM #23 abort audit: once a call
 * opens, walk to its matching close paren and check whether `untrustedTrigger`
 * appears anywhere inside the argument span.
 */
function findDelegationCallsMissingFlag(file: string): {
  total: number;
  missing: Finding[];
} {
  const src = fs.readFileSync(file, "utf8").split("\n");
  let inCall = false;
  let depth = 0;
  let callStart = 0;
  let callee = "";
  let hasFlag = false;
  let total = 0;
  const missing: Finding[] = [];

  for (let i = 0; i < src.length; i++) {
    const line = src[i];
    if (!inCall) {
      const m = DELEGATION_CALL.exec(line);
      if (m) {
        inCall = true;
        depth = 0;
        callStart = i + 1;
        callee = m[1];
        hasFlag = false;
        total++;
      }
    }
    if (inCall) {
      if (/untrustedTrigger/.test(line)) hasFlag = true;
      for (const ch of line) {
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) {
            if (!hasFlag) missing.push({ file, line: callStart, callee });
            inCall = false;
            break;
          }
        }
      }
    }
  }
  return { total, missing };
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("PM #92 — untrustedTrigger threaded through every delegated run", () => {
  const files = ROOTS.flatMap((r) => (fs.existsSync(r) ? collectTsFiles(r) : []));
  const scanned = files.map(findDelegationCallsMissingFlag);
  const totalCalls = scanned.reduce((n, s) => n + s.total, 0);
  const missing = scanned.flatMap((s) => s.missing);

  it("actually finds the delegation callsites (guards against a vacuous pass)", () => {
    // If the regex breaks, every assertion below passes for the wrong reason —
    // the same false-confidence trap the abort gate guards against. There are
    // 2 real call sites today (tool.ts -> callSubordinate, call-subordinate.ts
    // -> runSubordinateAgent); floor at 2 so a DELETED hop is caught too.
    expect(totalCalls).toBeGreaterThanOrEqual(2);
  });

  it("forwards untrustedTrigger at every delegation callsite", () => {
    expect(
      missing,
      "A delegated run that does not receive the parent's `untrustedTrigger` " +
        "rebuilds a FULL toolset — an untrusted external user reaches the host " +
        "shell through one `call_subordinate` hop (PM #92). Forward the flag at:\n" +
        missing.map((m) => `  ${m.file}:${m.line} -> ${m.callee}(...)`).join("\n")
    ).toEqual([]);
  });

  it("the untrusted entry point still marks external runs as untrusted", () => {
    // Without this, every assertion above holds while the flag is never TRUE
    // for anyone — the gate would be perfectly threaded and completely inert.
    const src = fs.readFileSync(UNTRUSTED_ENTRY, "utf8");
    expect(
      /untrustedTrigger:\s*true/.test(src),
      `${UNTRUSTED_ENTRY} must set \`untrustedTrigger: true\` — it is the only ` +
        `place external (prompt-injectable) traffic is marked untrusted. Without ` +
        `it the whole PM #92 gate is inert.`
    ).toBe(true);
  });

  it.each(CONSUMERS)("%s still reads the flag to gate its capability", (file) => {
    const src = fs.readFileSync(file, "utf8");
    expect(
      /context\.untrustedTrigger/.test(src),
      `${file} no longer reads \`context.untrustedTrigger\`. The RCE-class tool ` +
        `family and the MCP surface must stay denied to untrusted triggers ` +
        `unless \`settings.codeExecution.allowExternalTriggers\` is set (PM #92).`
    ).toBe(true);
  });
});

describe("PM #92 — the call_subordinate hop carries the value, not just the name", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("passes the parent's untrustedTrigger into runSubordinateAgent", async () => {
    const runSubordinateAgent = vi.fn().mockResolvedValue({ text: "done" });
    vi.doMock("@/lib/agent/agent", () => ({ runSubordinateAgent }));

    const { callSubordinate } = await import("@/lib/tools/call-subordinate");
    await callSubordinate(
      "task",
      undefined, // projectId
      0, // parentAgentNumber
      [], // parentHistory
      undefined, // abortSignal
      undefined, // parentChatId — skips the budget + bubble-up paths
      true // untrustedTrigger
    );

    expect(runSubordinateAgent).toHaveBeenCalledTimes(1);
    expect(runSubordinateAgent.mock.calls[0][0]).toMatchObject({
      untrustedTrigger: true,
    });
  });

  it("does not fabricate trust when the parent is trusted", async () => {
    const runSubordinateAgent = vi.fn().mockResolvedValue({ text: "done" });
    vi.doMock("@/lib/agent/agent", () => ({ runSubordinateAgent }));

    const { callSubordinate } = await import("@/lib/tools/call-subordinate");
    await callSubordinate("task", undefined, 0, [], undefined, undefined);

    // A trusted parent leaves it undefined — the gates treat that as trusted.
    // Asserting the negative pins that the hop is a pass-through, not a default.
    expect(runSubordinateAgent.mock.calls[0][0].untrustedTrigger).toBeUndefined();
  });
});
