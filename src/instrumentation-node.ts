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
