/**
 * Shared pricing contract. Its own module so `openrouter-pricing.ts` can depend
 * on the type WITHOUT importing `pricing.ts` — which imports a function
 * (`getCachedOpenRouterPricing`) back from `openrouter-pricing.ts`. That value
 * import is the one real runtime edge; routing the type through here removes the
 * madge-flagged cycle.
 */
export interface ModelPricing {
  /** USD charged per 1,000,000 prompt tokens. */
  inputUsdPerMillion: number;
  /** USD charged per 1,000,000 completion tokens. */
  outputUsdPerMillion: number;
  /**
   * USD per 1,000,000 prompt tokens that were served from the provider's
   * PROMPT CACHE. Optional: absent when the provider publishes no cache price,
   * in which case cached tokens fall back to the full input rate.
   *
   * Why this exists: providers discount a cache read heavily — OpenRouter
   * lists `anthropic/claude-sonnet-4` at 0.000003 per prompt token and
   * 0.0000003 per cache read, a 10x difference, and 235 models publish such a
   * price. Charging every prompt token at the full rate therefore OVERSTATES
   * the bill, and it overstates it WORST on a swarm turn, where the same long
   * prefix is re-sent to the Router, every proposer, the Skeptic and the
   * aggregator — precisely the shape prompt caching exists to make cheap. The
   * operator measured roughly 8x over-reporting on MoA runs, which is what a
   * 10x mispricing of the cached majority of the input produces.
   */
  cacheReadUsdPerMillion?: number;
}
