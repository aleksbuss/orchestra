/**
 * Extracted from `moa.ts` (DDD Skeptic-override track, §8 zero-net-growth
 * offset). A pure, self-contained per-ensemble context-window resolver.
 * Re-exported from `./moa` so callers/tests import site is unchanged.
 */

import { resolveContextWindow } from "@/lib/providers/context-window";

/**
 * Build a context-window resolver memoized for a single ensemble run (audit fix
 * #4). Keyed by provider|model|baseUrl; stores the in-flight PROMISE so that
 * concurrent proposers sharing a config await ONE probe instead of racing N.
 */
export function createWindowResolver(
  abortSignal?: AbortSignal
): (config: { provider: string; model?: string; baseUrl?: string }) => Promise<number> {
  const cache = new Map<string, Promise<number>>();
  return (config) => {
    const key = `${config.provider}|${config.model ?? ""}|${
      (config as { baseUrl?: string }).baseUrl ?? ""
    }`;
    let p = cache.get(key);
    if (!p) {
      p = resolveContextWindow(config, { abortSignal });
      cache.set(key, p);
    }
    return p;
  };
}
