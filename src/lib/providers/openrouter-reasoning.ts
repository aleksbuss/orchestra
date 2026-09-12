/**
 * PM #137 — why this exists.
 *
 * Orchestra reaches OpenRouter through `createOpenAI` from `@ai-sdk/openai`
 * (it needs the OR-* headers, so it builds its own provider). OpenRouter's
 * streaming format carries a reasoning model's thinking in a NON-STANDARD
 * `delta.reasoning` / `delta.reasoning_details` field. The OpenAI adapter has
 * never heard of that field, so it silently drops every one of those chunks.
 *
 * The consequence is not a degraded answer, it is a dead turn:
 *
 *   - the provider streams continuously from ~2s, hundreds of reasoning chunks;
 *   - the adapter emits NO `text-delta` and NO `reasoning-delta`, so
 *     `agent.ts`'s `onChunk` never fires and `watchdog.noteActivity()` is never
 *     called;
 *   - the time-to-first-token watchdog aborts at 90s with
 *     "<endpoint> sent no response within 90s", which is FALSE — the provider
 *     answered in two seconds.
 *
 * Measured through Orchestra's own `createModel`, same ~10K-token prompt:
 *
 *   deepseek/deepseek-chat (no reasoning)  first onChunk 2091ms, 645 text-delta
 *   qwen/qwen3.8-flash     (reasoning)     first onChunk NEVER, 0 chunks
 *   qwen/qwen3.6-plus      (reasoning)     first onChunk NEVER, 0 chunks
 *
 * RAISING THE WATCHDOG BUDGET DOES NOT FIX IT, and that is worth knowing before
 * someone tries: the probe was allowed to run to `finish` and produced ZERO
 * characters, because the whole output budget went into reasoning the adapter
 * discarded. At `max_tokens: 8192` the model emitted 2496 reasoning chunks and
 * still never reached content. A watchdog change alone converts "aborted at
 * 90s" into "empty answer after full billing".
 *
 * So the body field is the fix available without a new provider dependency.
 * Measured on `qwen/qwen3.8-flash`, streaming, same prompt:
 *
 *   (nothing)                      reasoning@1.8s  content@never   0 chars
 *   reasoning={"exclude":true}     reasoning@never content@never   0 chars
 *   reasoning={"effort":"low"}     reasoning@2.0s  content@never   0 chars
 *   reasoning={"enabled":false}    reasoning@never content@2.1s  405 chars ✅
 *
 * `exclude` only hides the reasoning from the response — the model still spends
 * the budget thinking, so it is strictly worse than doing nothing. Only
 * `enabled: false` makes the model answer directly.
 *
 * THE REAL FIX is an OpenRouter-aware provider that maps `delta.reasoning` onto
 * the SDK's `reasoning-delta` part, so the watchdog is fed and the thinking is
 * kept. `@openrouter/ai-sdk-provider@2.10.0` peers `ai@^6.0.0` and is therefore
 * compatible with the pinned `ai@6.0.193`. Until that lands this wrapper is
 * what keeps every OpenRouter reasoning model usable at all, and
 * `ORCHESTRA_OPENROUTER_REASONING=on` is the way to turn it off.
 */

/** Strict-string opt-out: `on` leaves the request body exactly as the SDK built it. */
function reasoningLeftEnabled(): boolean {
  return process.env.ORCHESTRA_OPENROUTER_REASONING === "on";
}

/**
 * Add `reasoning: { enabled: false }` to an OpenRouter chat-completion body.
 *
 * Fails SAFE in every direction: a body that is not a JSON string, does not
 * parse, is not an object, carries no `messages` (so: embeddings, model
 * listings, anything that is not a chat completion), or already states a
 * `reasoning` preference is returned UNTOUCHED. A caller that wants reasoning
 * on one specific call therefore just sets the field itself.
 */
export function disableReasoningInBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.messages)) return body;
  if ("reasoning" in obj || "reasoning_effort" in obj) return body;
  return JSON.stringify({ ...obj, reasoning: { enabled: false } });
}

/**
 * Wrap a fetch so OpenRouter chat completions ask the model not to reason.
 * Composes around `createHeadersTimeoutFetch` rather than replacing it — the
 * PM #98 headers bound must stay on this path.
 */
export function withOpenRouterReasoningDisabled(
  inner: typeof globalThis.fetch
): typeof globalThis.fetch {
  return async (input, init) => {
    if (reasoningLeftEnabled() || !init?.body) return inner(input, init);
    const body = disableReasoningInBody(init.body);
    if (body === init.body) return inner(input, init);

    // The body length changed. `fetch` recomputes Content-Length for a string
    // body, but only if no explicit header contradicts it — so drop one if the
    // caller set it, rather than shipping a length that no longer matches.
    const headers = new Headers(init.headers as HeadersInit | undefined);
    headers.delete("content-length");
    return inner(input, { ...init, body: body as BodyInit, headers });
  };
}
