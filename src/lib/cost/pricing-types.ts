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
}
