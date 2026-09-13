/**
 * The activity pane's status line (PM #138).
 *
 * This pane used to render only for swarm turns, so its header could say
 * "Swarm" unconditionally. Step 2 opened it on every turn, which made that
 * wording a false statement about a plain single-agent run — a defect found by
 * re-reading the component AFTER the un-gating shipped, not before.
 *
 * The e2e spec (`tests/e2e/swarm.spec.ts`) drives a real swarm turn and asserts
 * on the swarm wording, so the swarm branch has an end-to-end witness. These
 * cases own the branch it cannot reach: the single-agent one.
 */
import { describe, it, expect } from "vitest";
import { dagStatusLabel, summarizeDagNodes } from "@/components/chat/swarm-dag";

describe("dagStatusLabel — a plain turn never claims a swarm ran", () => {
  it("running", () => {
    expect(
      dagStatusLabel({ isActuallyFinished: false, hasErrors: false, isSwarmRun: false, runningCount: 1 })
    ).toBe("Agent Active — working");
  });

  it("completed", () => {
    expect(
      dagStatusLabel({ isActuallyFinished: true, hasErrors: false, isSwarmRun: false, runningCount: 0 })
    ).toBe("Turn Completed");
  });

  it("failed", () => {
    expect(
      dagStatusLabel({ isActuallyFinished: true, hasErrors: true, isSwarmRun: false, runningCount: 0 })
    ).toBe("Turn Failed");
  });

  it("no single-agent label contains the word Swarm", () => {
    const labels = [
      dagStatusLabel({ isActuallyFinished: false, hasErrors: false, isSwarmRun: false, runningCount: 3 }),
      dagStatusLabel({ isActuallyFinished: true, hasErrors: false, isSwarmRun: false, runningCount: 0 }),
      dagStatusLabel({ isActuallyFinished: true, hasErrors: true, isSwarmRun: false, runningCount: 0 }),
    ];
    for (const l of labels) expect(l.toLowerCase()).not.toContain("swarm");
  });
});

describe("dagStatusLabel — the swarm wording is unchanged", () => {
  it("running, plural", () => {
    expect(
      dagStatusLabel({ isActuallyFinished: false, hasErrors: false, isSwarmRun: true, runningCount: 3 })
    ).toBe("Swarm Active — 3 agents thinking");
  });

  it("running, singular", () => {
    expect(
      dagStatusLabel({ isActuallyFinished: false, hasErrors: false, isSwarmRun: true, runningCount: 1 })
    ).toBe("Swarm Active — 1 agent thinking");
  });

  it("completed", () => {
    expect(
      dagStatusLabel({ isActuallyFinished: true, hasErrors: false, isSwarmRun: true, runningCount: 0 })
    ).toBe("Swarm Work Completed");
  });

  it("failed", () => {
    expect(
      dagStatusLabel({ isActuallyFinished: true, hasErrors: true, isSwarmRun: true, runningCount: 0 })
    ).toBe("Swarm Execution Failed");
  });

  /**
   * `tests/e2e/swarm.spec.ts` matches `/agents? thinking|Swarm Work Completed|
   * Swarm Execution Failed/i`. Changing any of those strings silently breaks a
   * gate that takes 2.3 minutes to tell you — pin the contract here instead.
   */
  it("every swarm label still satisfies the e2e regex", () => {
    const e2e = /agents? thinking|Swarm Work Completed|Swarm Execution Failed/i;
    for (const args of [
      { isActuallyFinished: false, hasErrors: false, isSwarmRun: true, runningCount: 2 },
      { isActuallyFinished: true, hasErrors: false, isSwarmRun: true, runningCount: 0 },
      { isActuallyFinished: true, hasErrors: true, isSwarmRun: true, runningCount: 0 },
    ]) {
      expect(dagStatusLabel(args)).toMatch(e2e);
    }
  });
});

/**
 * The derivation the label's own tests structurally cannot reach: they take
 * `isSwarmRun` as an input. A mutant changing `> 1` to `>= 1` survived every
 * case above, which is exactly why this block exists.
 */
describe("summarizeDagNodes — what counts as a swarm run", () => {
  const n = (role: string, status: string) => ({ role, status });

  it("a plain turn — one orchestrator root plus tool nodes — is NOT a swarm run", () => {
    const s = summarizeDagNodes([
      n("orchestrator", "completed"),
      n("tool", "completed"),
      n("tool", "completed"),
    ]);
    expect(s.isSwarmRun).toBe(false);
    expect(s.totalAgentNodes).toBe(1);
    expect(s.toolCount).toBe(2);
  });

  it("the root ALONE, before any tool ran, is not a swarm run either", () => {
    expect(summarizeDagNodes([n("orchestrator", "running")]).isSwarmRun).toBe(false);
  });

  it("an empty graph is not a swarm run", () => {
    const s = summarizeDagNodes([]);
    expect(s.isSwarmRun).toBe(false);
    expect(s.totalAgentNodes).toBe(0);
  });

  it("a second agent node — a proposer — makes it a swarm run", () => {
    const s = summarizeDagNodes([n("orchestrator", "running"), n("coder", "running")]);
    expect(s.isSwarmRun).toBe(true);
    expect(s.totalAgentNodes).toBe(2);
  });

  it("tool nodes NEVER promote a turn to a swarm run, however many there are", () => {
    const many = [n("orchestrator", "running"), ...Array.from({ length: 40 }, () => n("tool", "completed"))];
    const s = summarizeDagNodes(many);
    expect(s.isSwarmRun).toBe(false);
    expect(s.toolCount).toBe(40);
  });

  it("counts errors and running nodes in the same pass", () => {
    const s = summarizeDagNodes([
      n("orchestrator", "running"),
      n("coder", "error"),
      n("tool", "running"),
    ]);
    expect(s.hasErrors).toBe(true);
    expect(s.runningCount).toBe(2);
  });

  it("no error anywhere means hasErrors is false", () => {
    expect(summarizeDagNodes([n("orchestrator", "completed"), n("tool", "completed")]).hasErrors).toBe(false);
  });
});
