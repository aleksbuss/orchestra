/**
 * Combine an optional parent `AbortSignal` with a fresh timeout, returning a
 * single signal that aborts on whichever fires first.
 *
 * Why this exists: PM #1 residual gap fix (Defect #5). Earlier ad-hoc helpers
 * had a fallback path that returned `parent` alone when `AbortSignal.any` was
 * unavailable (Node 20.0–20.2), silently dropping the timeout. A hung upstream
 * could then pin the agent indefinitely. This helper ALWAYS provides a working
 * timeout, regardless of runtime version.
 */
export function combineWithTimeout(
  parent: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!parent) return timeout;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([parent, timeout]);
  }

  // Manual combine for runtimes without AbortSignal.any (Node 20.0–20.2).
  // The result aborts on the first input to abort.
  const controller = new AbortController();
  const propagate = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  if (parent.aborted) {
    controller.abort();
    return controller.signal;
  }
  if (timeout.aborted) {
    controller.abort();
    return controller.signal;
  }
  parent.addEventListener("abort", propagate, { once: true });
  timeout.addEventListener("abort", propagate, { once: true });
  return controller.signal;
}
