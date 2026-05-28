/**
 * Node-runtime boot work for PM #35. This file is the sibling of
 * `instrumentation.ts` and is recognised by Next.js's bundler — only the
 * Node bundle includes it, the edge bundle does not. Anything Node-only
 * (`fs/promises`, `process.once`, `child_process`-pulling MCP SDK, etc.)
 * lives HERE, not in `instrumentation.ts`.
 *
 * Side effects on import:
 *   1. `chat-store` evaluates its top-level IIFE that installs the
 *      SIGTERM/SIGINT flush handler (PM #29). The handler is idempotent
 *      via `globalThis.__orchestraChatStoreFlushHandlersInstalled__` so
 *      dev-mode HMR doesn't stack listeners.
 *   2. `ensureCronSchedulerStarted()` boots the cron scheduler, queue
 *      recovery, ghost-task sweep, and `data/`-cleanup sweepers
 *      (PM #32). It is itself idempotent via
 *      `globalThis.__orchestraCronScheduler__`.
 *   3. PM #43 — `detectLocalBackends()` probes localhost ports for
 *      SGLang/vLLM/Ollama/LM Studio/LocalAI. Result is logged so the
 *      operator sees on boot which local backends are reachable and
 *      gets a hint to launch SGLang with `--enable-prefix-caching` if
 *      missing. Fire-and-forget (the boot doesn't wait on probes).
 *   4. PM #44 — `buildHardwareReport()` fingerprints CPU/RAM/GPU and
 *      logs three suggested MoA configs (speed/balanced/quality)
 *      tailored to the host. First-touch wow-effect for power users
 *      with a 24GB GPU or 64GB Apple Silicon. Fire-and-forget too.
 *
 * Test coverage lives in `instrumentation.test.ts` against the public
 * `register()` surface; this file has no own test because its body is
 * dead-simple wiring and the integration is exercised by the smoke boot
 * (`npm run dev` → grep `[sweepers] Completed sweep` in the dev log).
 */

import { ensureCronSchedulerStarted } from "@/lib/cron/runtime";

// Side-effect import: evaluating the module installs the SIGTERM/SIGINT
// flush handler at the top level. The empty named binding is intentional —
// we don't need any exports, just the module evaluation.
import "@/lib/storage/chat-store";

await ensureCronSchedulerStarted();

// PM #43 — fire-and-forget local-backend probe. The result is informative,
// not load-bearing: even if every probe times out, Orchestra still works
// (the operator can run on cloud providers). `void` so a misbehaving
// network stack can't stall the boot.
void (async () => {
  try {
    const [{ detectLocalBackends, formatDetectionSummary }] = await Promise.all([
      import("@/lib/providers/local-backend-detect"),
    ]);
    const results = await detectLocalBackends();
    console.log(formatDetectionSummary(results));
    const sglangAvailable = results.some(
      (r) => r.available && r.candidate.provider === "sglang"
    );
    const vllmAvailable = results.some(
      (r) => r.available && r.candidate.provider === "vllm"
    );
    if (!sglangAvailable && !vllmAvailable) {
      console.log(
        "[LocalBackends] Hint: for best MoA throughput on local hardware, run SGLang or vLLM with `--enable-prefix-caching`. See docs/ARCHITECTURE.md § local-first."
      );
    }
  } catch (err) {
    console.warn("[LocalBackends] probe failed (non-fatal):", err);
  }
})();

// PM #44 — hardware fingerprint + MoA config recommendations. Same
// fire-and-forget shape; output is informative, not load-bearing. The
// operator sees a multi-line block describing their hardware and three
// suggested configs they can paste into Settings.
void (async () => {
  try {
    const { buildHardwareReport } = await import(
      "@/lib/providers/hardware-detect"
    );
    const report = await buildHardwareReport();
    console.log(report.summary);
  } catch (err) {
    console.warn("[Hardware] fingerprint failed (non-fatal):", err);
  }
})();
