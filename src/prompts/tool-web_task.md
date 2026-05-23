# Tool: `web_task`

**Autonomous web automation.** Open a URL, walk the page, complete a task.

## When to use this tool

Use `web_task` when the user asks you to:
- Look up specific data on a known website (prices, availability, schedules)
- Submit a form on their behalf
- Log into a site and perform a sequence of clicks
- Extract structured content from one or two pages
- Verify something on a live site (e.g. "did the deploy land?")

## When NOT to use this tool

- **General web research across many sources** → use `search_web` instead. `web_task` opens ONE site; `search_web` queries an index.
- **You already know the answer or it's in the model's training data** → answer directly.
- **One-off browser snapshots / screenshots** → use the `agent-browser` or `playwright-cli` skills via Bash. They're cheaper (no inner LLM loop) and give you direct manual control.
- **The site requires login credentials the user hasn't provided** → ask the user first.

## How it works

`web_task` runs an inner LLM loop:

1. Open the URL in a headless browser.
2. Take a structured snapshot of interactive elements (`@e1`, `@e2`, …).
3. Inner model picks the next action: `click(ref)`, `fill(ref, text)`, `goto(url)`, `done(result)`, or `fail(reason)`.
4. Execute, re-snapshot, loop.
5. Stop on `done` / `fail` / iteration cap (default 10, max 20) / 3-minute wall-clock.

You get back a **single result object** — not the full action trace. If you need step-by-step browser control, use the CLI skills.

## Input

- `url` — absolute URL to start at.
- `task` — natural-language goal. Be specific. "Find the cheapest standard room" beats "look up hotel info".
- `maxIterations` (optional) — default 10. Raise for genuinely multi-step flows (e.g. login → navigate → extract).

## Output shape

```ts
{
  success: boolean,
  result: string,            // final answer (on done) or error message (on fail)
  iterations: number,
  finalUrl: string,
  actions: Array<{ type, ref? }>,
  durationMs: number,
}
```

## Cost & failure modes

- Each iteration is a full LLM call on `settings.chatModel` plus a Playwright round-trip. Budget ~1-5s per iteration.
- Hard caps: 20 iterations, 3 minutes total. Both are uncrossable.
- Common failure: CAPTCHA / paywall / bot-detection block. Inner model returns `fail` with a clear reason — no infinite retries.
- Browser process is always closed in `finally`, even on abort. Won't leak chromium.

## Examples

```ts
// Good: specific, single-site task with a clear endpoint
web_task({
  url: "https://news.ycombinator.com",
  task: "Find the top story title and its score. Return them as 'TITLE — SCORE'."
})

// Good: form submission
web_task({
  url: "https://example.com/contact",
  task: "Fill the contact form with name 'John', email 'john@example.com', message 'Hi'. Submit and report success."
})

// Bad: too broad — use search_web instead
web_task({ url: "https://google.com", task: "Find me a good Italian restaurant in NYC" })

// Bad: ambiguous endpoint — model won't know when to stop
web_task({ url: "https://twitter.com", task: "Look around" })
```

## Rules

- Always wait for the result. The tool is synchronous from the agent's POV; don't try to fire-and-forget.
- If `success: false`, surface the `result` (it's the failure reason) and ask the user whether to retry with different inputs.
- The tool inherits your active `chatModel` for inner decisions. A weak model = a brittle loop. Use a capable model for non-trivial sites.
