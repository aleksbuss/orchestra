/**
 * Bounded boot-probe helper.
 *
 * `instrumentation-node.ts` fires several fire-and-forget probes during
 * Next.js boot — local-backend port scan, hardware fingerprint (spawns
 * `nvidia-smi`), settings reads, OpenRouter pricing refresh. Each one
 * has been written with internal error handling, but none with a
 * timeout. A misbehaving network stack / `nvidia-smi` hang / stalled
 * `fs.readFile` on a network mount would leave the promise pending
 * forever, holding a small chunk of memory and a stack trace nobody
 * can interpret six weeks later.
 *
 * `boundedBootProbe(name, timeoutMs, fn)` races the probe against an
 * `AbortSignal.timeout` and logs the timeout case explicitly. The
 * underlying work may continue (we can't always thread an abort signal
 * into nvidia-smi), but the boot path stops awaiting it, so a hanging
 * probe doesn't keep an unresolved promise alive in the boot scope.
 *
 * Choice of timeouts (in instrumentation-node.ts callsites):
 *   - 10s for network probes (detectLocalBackends, OpenRouter pricing)
 *   - 5s for child_process-pulling fingerprint (buildHardwareReport)
 *   - 2s for pure fs settings reads (privacy mode, tournament warning)
 *
 * The helper exits cleanly on success, on caller-thrown error, and on
 * timeout — never throws back into the boot scope. Boot stays
 * fire-and-forget regardless of how each probe behaves.
 */

export interface BootProbeOptions {
  /** Short tag for log lines, e.g. "LocalBackends". */
  name: string;
  /** Time budget; if the probe doesn't resolve within this window, log + give up. */
  timeoutMs: number;
}

export async function boundedBootProbe<T>(
  opts: BootProbeOptions,
  fn: () => Promise<T>
): Promise<T | undefined> {
  const { name, timeoutMs } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutSignal = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `[${name}] boot probe timed out after ${timeoutMs}ms — giving up; underlying work may still run.`
      );
      resolve(undefined);
    }, timeoutMs);
    // Don't hold the event loop alive just for the bail-out timer.
    timer.unref?.();
  });

  try {
    const result = await Promise.race([fn(), timeoutSignal]);
    return result;
  } catch (err) {
    console.warn(`[${name}] boot probe failed (non-fatal):`, err);
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
