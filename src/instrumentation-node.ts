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
import { enforceSingleProcessOrExit } from "@/lib/util/multi-process-guard";
import { boundedBootProbe } from "@/lib/util/boot-probe";

// FIRST thing on the Node bundle. If we're running as a PM2 cluster
// worker OR a node:cluster.fork() child OR carry NODE_UNIQUE_ID, the
// withFileLock single-process invariant (CLAUDE.md Critical Rule §1)
// is violated and the operator gets a precise fatal exit instead of
// a slow drip of lost-update data corruption. Bypass:
// ORCHESTRA_MULTI_PROCESS_OK=true (after migrating to advisory lockfile).
enforceSingleProcessOrExit();

// Side-effect import: evaluating the module installs the SIGTERM/SIGINT
// flush handler at the top level. The empty named binding is intentional —
// we don't need any exports, just the module evaluation.
import "@/lib/storage/chat-store";

await ensureCronSchedulerStarted();

// PM #43 — fire-and-forget local-backend probe. The result is informative,
// not load-bearing: even if every probe times out, Orchestra still works
// (the operator can run on cloud providers). Wrapped in boundedBootProbe
// so a misbehaving network stack can't keep the boot scope holding an
// unresolved promise.
void boundedBootProbe(
  { name: "LocalBackends", timeoutMs: 10_000 },
  async () => {
    const { detectLocalBackends, formatDetectionSummary } = await import(
      "@/lib/providers/local-backend-detect"
    );
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
  }
);

// PM #44 — hardware fingerprint + MoA config recommendations. Spawns
// `nvidia-smi` / `system_profiler` on some hosts; 5s budget keeps a
// misbehaving GPU driver from holding the boot.
void boundedBootProbe(
  { name: "Hardware", timeoutMs: 5_000 },
  async () => {
    const { buildHardwareReport } = await import(
      "@/lib/providers/hardware-detect"
    );
    const report = await buildHardwareReport();
    console.log(report.summary);
  }
);

// PM #47 — surface privacy-mode state on boot. Pure settings read; 2s
// is comfortable for a local fs round-trip even on slow disks.
void boundedBootProbe(
  { name: "Privacy", timeoutMs: 2_000 },
  async () => {
    const { getSettings } = await import("@/lib/storage/settings-store");
    const settings = await getSettings();
    if (settings.privacyMode?.enabled) {
      console.log(
        "[Privacy] Privacy Mode is ENABLED. runAgent will refuse any non-local model — chatModel, utilityModel, and embeddingsModel must all target ollama / sglang / vllm / custom-loopback."
      );
    } else {
      console.log(
        "[Privacy] Privacy Mode is off. Enable in settings.json (privacyMode.enabled = true) for air-gapped MoA with local-only backends."
      );
    }
  }
);

// PM #54 — warn on boot when tournament mode is combined with coder
// code_execution. Pure settings read; 2s budget.
void boundedBootProbe(
  { name: "MoA", timeoutMs: 2_000 },
  async () => {
    const { getSettings } = await import("@/lib/storage/settings-store");
    const settings = await getSettings();
    const tournamentOn = settings.aggregator?.mode === "tournament";
    const proposerCodeExec =
      settings.codeExecution?.enabled === true &&
      settings.codeExecution.proposerAccess === true;
    if (tournamentOn && proposerCodeExec) {
      console.warn(
        "[MoA] Risky combo detected: aggregator.mode=tournament + codeExecution.proposerAccess=true. " +
          "ALL coder proposers will run code in the same project cwd; only the winning draft is shown, " +
          "but losing proposers' side effects (files written, packages installed) PERSIST. " +
          "No per-proposer sandbox yet — see PM #54 closing notes. Consider disabling proposerAccess for tournament chats."
      );
    }
  }
);

// PM #49 — refresh the OpenRouter pricing cache. Live HTTPS to
// openrouter.ai/api/v1/models; 10s budget matches the network-probe
// category. Skipped entirely in Privacy Mode.
void boundedBootProbe(
  { name: "OpenRouterPricing", timeoutMs: 10_000 },
  async () => {
    const { getSettings } = await import("@/lib/storage/settings-store");
    const settings = await getSettings();
    if (settings.privacyMode?.enabled) {
      console.log(
        "[OpenRouterPricing] Privacy Mode is ENABLED — skipping live pricing fetch (would break air-gap). Cost banner falls back to hardcoded table."
      );
      return;
    }
    const { refreshOpenRouterPricingCache } = await import(
      "@/lib/cost/openrouter-pricing"
    );
    const result = await refreshOpenRouterPricingCache();
    console.log(
      `[OpenRouterPricing] ${result.source} — ${result.entryCount} models priced.`
    );
  }
);
