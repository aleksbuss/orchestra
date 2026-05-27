/**
 * Next.js boot hook (PM #35). The `register()` export is called once per
 * server start — exactly the lifecycle anchor Orchestra previously lacked.
 *
 * Why this file exists: prior to PM #35, two pieces of cold-boot work were
 * gated behind a lazy-init pattern that depended on the first authenticated
 * request:
 *
 *   - `chat-store` SIGTERM/SIGINT flush (PM #29) — only installed when
 *     something caused chat-store to be loaded for the first time. An operator
 *     who booted the server, sat idle, and then ran `kill -TERM` before any
 *     traffic still lost the last debounce window of writes from any
 *     background work.
 *   - cron scheduler + sweepers + ghost-task cleanup (PM #32) — wired into
 *     `ensureCronSchedulerStarted()`, which was only invoked from `/api/chat`
 *     and `/api/cron/*`. A cold-boot deployment that received only
 *     anonymous `/api/health` traffic never ran the sweepers, and stale files
 *     in `data/tmp/` + orphaned queue entries accumulated indefinitely.
 *
 * The hook resolves both: every cold boot installs the SIGTERM handler and
 * starts the scheduler, regardless of subsequent traffic shape.
 *
 * Why the paired-file pattern: Next.js bundles `instrumentation.ts` for BOTH
 * the node and edge runtimes. Importing `@/lib/cron/runtime` directly here
 * would drag Node-only modules (`@modelcontextprotocol/sdk` → `cross-spawn`
 * → `child_process`) into the edge bundle and break the edge build. The
 * canonical fix from the Next.js docs is the `instrumentation-node.ts`
 * sibling — the suffix is special-cased by the compiler and only bundled
 * into the Node runtime, so the dynamic import below is a no-op at edge
 * compile time.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
