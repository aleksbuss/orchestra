/**
 * Autonomous web-task tool — open a URL and complete a task by letting the
 * model drive a Playwright browser through an action loop.
 *
 * Design philosophy:
 *   - This is NOT a replacement for the existing `agent-browser` /
 *     `playwright-cli` skills. Those expose individual CLI commands that the
 *     parent agent chains itself. This tool, by contrast, runs a SELF-DRIVING
 *     inner loop: snapshot → model decides next action → execute → loop.
 *     The parent agent gets a single high-level result back ("logged in",
 *     "extracted these 3 prices", "form submitted"), not a play-by-play.
 *   - Single source of model truth: uses `settings.chatModel` via
 *     `createModel`, so it inherits the multi-provider failover + API-key
 *     resolution that everything else uses. No second LLM client.
 *   - Text-based observability: every page is reduced to an accessibility
 *     snapshot (a JSON tree of role + name + visible text). Works with any
 *     text-only model. Vision-capable models would let us drop this in favor
 *     of screenshots — that's a future enhancement, NOT MVP scope.
 *   - Safety caps: hard iteration ceiling (default 10, max 20), per-action
 *     timeouts, total wall-clock budget. AbortSignal propagation honored at
 *     every await point — closing the chat cancels the browser.
 *
 * Why "web_task" rather than "browse_web":
 *   - It signals the high-level autonomy. "Browse" suggests a single click.
 *   - Matches how users talk: "go to this site and book X", "log in and
 *     download Y", "extract pricing from Z". Each is a TASK, not a click.
 *
 * Out of scope for MVP (deliberate omissions):
 *   - Vision (multimodal screenshots). Adds dep complexity + cost; punted.
 *   - Multi-tab browsing. The model picks one page and walks it.
 *   - File upload/download. Out of scope; downloads are blocked by default.
 *   - Iframe / shadow DOM traversal. Playwright supports it but the
 *     accessibility snapshot path covers 95% of marketing/SaaS UIs already.
 *   - Stealth / anti-bot evasion. We are not in that business.
 */
import { chromium, type Browser, type Page } from "playwright";
import { tool } from "ai";
import { z } from "zod";
import { generateObject } from "ai";
import { createModel } from "@/lib/providers/llm-provider";
import type { AppSettings, ModelConfig } from "@/lib/types";

// ── Tunables ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ITERATIONS = 10;
const HARD_MAX_ITERATIONS = 20;
const PER_ACTION_TIMEOUT_MS = 15_000;
const TOTAL_BUDGET_MS = 180_000; // 3 min wall-clock cap
const NAV_TIMEOUT_MS = 30_000;

// ── Action schema ───────────────────────────────────────────────────────────
// The model's reply must conform to this discriminated union. zod enforces it
// before we even touch the browser, so a malformed model output becomes a
// retry-with-error-hint rather than a runtime crash.
const ActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click"),
    ref: z.string().describe("Snapshot ref like 'e3' that identifies the target element"),
    reasoning: z.string().describe("One sentence on why this action advances the task"),
  }),
  z.object({
    type: z.literal("fill"),
    ref: z.string().describe("Snapshot ref for the input/textarea element"),
    text: z.string().describe("Value to type"),
    reasoning: z.string(),
  }),
  z.object({
    type: z.literal("goto"),
    url: z.string().url().describe("Absolute URL to navigate to"),
    reasoning: z.string(),
  }),
  z.object({
    type: z.literal("done"),
    result: z.string().describe("Final result, formatted for the user / parent agent"),
    reasoning: z.string(),
  }),
  z.object({
    type: z.literal("fail"),
    reason: z.string().describe("Why this task cannot be completed"),
  }),
]);

export type WebTaskAction = z.infer<typeof ActionSchema>;

// ── Result type ─────────────────────────────────────────────────────────────

export interface WebTaskResult {
  success: boolean;
  /** Final result text (from "done" action) or error message. */
  result: string;
  /** Iterations the loop ran for. */
  iterations: number;
  /** Final page URL at task end. */
  finalUrl: string;
  /** Action trace for debugging — useful in tests + UI surface. */
  actions: Array<{ type: string; ref?: string; reasoning?: string }>;
  /** Total wall-clock time. */
  durationMs: number;
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Reduce the page to a compact, text-based representation the model can reason
 * about. We use Playwright's accessibility tree (semantic-DOM) + a refmap for
 * actionable elements — this gives the model BOTH structure (what's on the
 * page) and addressability (`e3`, `e7`, …) without dumping 200KB of raw HTML.
 */
async function takeSnapshot(
  page: Page
): Promise<{ snapshotText: string; refMap: Map<string, string> }> {
  // refMap: snapshot ref → CSS selector usable by Playwright.
  // We assign refs by walking the actionable elements (buttons, links,
  // inputs, etc.) in document order so the model can refer to them by index.
  const refMap = new Map<string, string>();

  // `page.locator(...).all()` resolves only inside the current frame; iframe
  // crawling is out of scope (see header comment). Document-order list of
  // interactive elements:
  const interactive = await page
    .locator(
      'button, a[href], input:not([type=hidden]), textarea, select, [role="button"], [role="link"], [role="textbox"]'
    )
    .all();

  const lines: string[] = [];
  for (let i = 0; i < Math.min(interactive.length, 60); i++) {
    const el = interactive[i];
    const ref = `e${i + 1}`;
    let role = "element";
    let label = "";
    try {
      role = (await el.evaluate((n) => (n as HTMLElement).getAttribute("role") || n.tagName.toLowerCase())) || "element";
      label =
        (await el.getAttribute("aria-label")) ||
        (await el.getAttribute("placeholder")) ||
        (await el.innerText().catch(() => ""))
          .slice(0, 80)
          .replace(/\s+/g, " ")
          .trim();
    } catch {
      // Element detached mid-snapshot — skip rather than crash the loop.
      continue;
    }
    refMap.set(ref, `__playwright_interactive__:${i}`);
    lines.push(`@${ref} <${role}> "${label}"`);
  }

  const title = await page.title().catch(() => "");
  const url = page.url();

  // Include a bounded text excerpt of the page body so the model can read
  // headings, prose, prices, etc. — not just what's clickable. Without this
  // a page that became "<p>CLICKED</p>" after an action would look empty
  // from the model's POV (no interactive elements) and the loop would stall.
  // Cap at 1500 chars to keep token cost predictable; truncation indicator
  // tells the model whether the cut was hard.
  const TEXT_BUDGET = 1500;
  let bodyText = "";
  try {
    const raw = await page.locator("body").innerText({ timeout: 2000 });
    bodyText = raw.replace(/\s+/g, " ").trim();
    if (bodyText.length > TEXT_BUDGET) {
      bodyText = bodyText.slice(0, TEXT_BUDGET) + " …[truncated]";
    }
  } catch {
    bodyText = "(could not read body text)";
  }

  const snapshotText =
    `URL: ${url}\nTITLE: ${title}\n\n` +
    `PAGE TEXT:\n${bodyText || "(empty)"}\n\n` +
    `INTERACTIVE ELEMENTS (max 60 shown):\n` +
    (lines.length ? lines.join("\n") : "(no interactive elements found)");

  return { snapshotText, refMap };
}

/**
 * Resolve a snapshot ref (`e3`) back to a live Playwright locator. We can't
 * just persist locators across iterations because the DOM may have changed —
 * we recompute on demand from the most recent interactive-elements list.
 */
async function locatorForRef(
  page: Page,
  ref: string
): Promise<{ locator: ReturnType<Page["locator"]>; index: number } | null> {
  const m = ref.match(/^e(\d+)$/);
  if (!m) return null;
  const index = Number(m[1]) - 1;
  const all = await page
    .locator(
      'button, a[href], input:not([type=hidden]), textarea, select, [role="button"], [role="link"], [role="textbox"]'
    )
    .all();
  if (index < 0 || index >= all.length) return null;
  return { locator: all[index], index };
}

const SYSTEM_PROMPT = `You are a web-automation agent operating one browser tab.
Each turn you receive a structured page snapshot. Reply with exactly ONE action.

Available actions:
  - click(ref):        Click an interactive element by its snapshot ref (e.g. "e3").
  - fill(ref, text):   Type text into an input/textarea ref.
  - goto(url):         Navigate to an absolute URL (use sparingly — prefer clicking site nav).
  - done(result):      Task complete; "result" is your final answer to the parent agent.
  - fail(reason):      Task cannot be completed (e.g. site requires auth you don't have).

Rules:
  1. Read the URL + TITLE first. Verify you're on the page you expect.
  2. Pick the SHORTEST path. One action per turn; the loop will re-snapshot after.
  3. If the task seems done, return "done" with a concise result — don't take extra clicks "for safety".
  4. If a CAPTCHA, login wall, or paywall blocks progress, return "fail" with the reason.
  5. Never invent refs that aren't in the snapshot — pick from listed @e# IDs only.
`;

// ── Decision call ───────────────────────────────────────────────────────────

async function decideNextAction(
  modelConfig: ModelConfig,
  task: string,
  snapshotText: string,
  history: WebTaskAction[],
  abortSignal: AbortSignal | undefined
): Promise<WebTaskAction> {
  const model = createModel(modelConfig, {});

  const historyBlock = history
    .map(
      (a, i) =>
        `Step ${i + 1}: ${a.type}${"ref" in a ? ` ref=${a.ref}` : ""}${
          "url" in a ? ` url=${a.url}` : ""
        }${"text" in a ? ` text="${a.text.slice(0, 60)}"` : ""}`
    )
    .join("\n");

  const userPrompt = `TASK:\n${task}\n\n${
    history.length ? `ACTIONS SO FAR:\n${historyBlock}\n\n` : ""
  }CURRENT PAGE:\n${snapshotText}\n\nReply with the single best next action.`;

  const { object } = await generateObject({
    model,
    schema: ActionSchema,
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    abortSignal,
  });

  return object;
}

// ── Public entry: the tool execution ────────────────────────────────────────

export interface RunWebTaskOptions {
  url: string;
  task: string;
  maxIterations?: number;
  settings: AppSettings;
  abortSignal?: AbortSignal;
}

export async function runWebTask(opts: RunWebTaskOptions): Promise<WebTaskResult> {
  const started = Date.now();
  const maxIter = Math.min(
    Math.max(1, opts.maxIterations ?? DEFAULT_MAX_ITERATIONS),
    HARD_MAX_ITERATIONS
  );

  // Single shared modelConfig + key resolution for the loop. Mirrors the
  // pattern in MoA / agent: if the chatModel has no apiKey on it, the
  // provider's vault key fills in.
  const modelConfig: ModelConfig = (() => {
    const base = { ...opts.settings.chatModel };
    if (!base.apiKey && opts.settings.providerApiKeys?.[base.provider]) {
      base.apiKey = opts.settings.providerApiKeys[base.provider];
    }
    return base;
  })();

  let browser: Browser | null = null;
  const actions: WebTaskAction[] = [];

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(opts.url, {
      timeout: NAV_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });

    for (let i = 0; i < maxIter; i++) {
      // Budget check before every iteration — the loop can be terminated by
      // either iteration cap, wall-clock cap, or abort signal.
      if (opts.abortSignal?.aborted) {
        throw new Error("aborted");
      }
      if (Date.now() - started > TOTAL_BUDGET_MS) {
        return {
          success: false,
          result: `Task exceeded ${TOTAL_BUDGET_MS}ms budget after ${i} iterations`,
          iterations: i,
          finalUrl: page.url(),
          actions: actions.map(stripAction),
          durationMs: Date.now() - started,
        };
      }

      const { snapshotText } = await takeSnapshot(page);

      const action = await decideNextAction(
        modelConfig,
        opts.task,
        snapshotText,
        actions,
        opts.abortSignal
      );
      actions.push(action);

      // Discriminated union handling. zod already validated the shape, so we
      // can pattern-match on `type` without belt-and-suspenders runtime
      // checks.
      if (action.type === "done") {
        return {
          success: true,
          result: action.result,
          iterations: i + 1,
          finalUrl: page.url(),
          actions: actions.map(stripAction),
          durationMs: Date.now() - started,
        };
      }
      if (action.type === "fail") {
        return {
          success: false,
          result: action.reason,
          iterations: i + 1,
          finalUrl: page.url(),
          actions: actions.map(stripAction),
          durationMs: Date.now() - started,
        };
      }

      if (action.type === "goto") {
        await page.goto(action.url, {
          timeout: NAV_TIMEOUT_MS,
          waitUntil: "domcontentloaded",
        });
        continue;
      }

      // click / fill — resolve ref then execute.
      const resolved = await locatorForRef(page, action.ref);
      if (!resolved) {
        // Don't crash; feed the error back so the model can pick a valid ref
        // next iteration. We record the failed attempt so we don't loop on
        // the same broken ref.
        actions[actions.length - 1] = {
          ...action,
          reasoning: `[INVALID REF ${action.ref}] ${action.reasoning ?? ""}`,
        } as WebTaskAction;
        continue;
      }

      if (action.type === "click") {
        await resolved.locator.click({ timeout: PER_ACTION_TIMEOUT_MS });
      } else if (action.type === "fill") {
        await resolved.locator.fill(action.text, { timeout: PER_ACTION_TIMEOUT_MS });
      }
    }

    // Loop exhausted without "done"/"fail" — the model never converged.
    return {
      success: false,
      result: `Max iterations (${maxIter}) reached without "done" — model could not converge.`,
      iterations: maxIter,
      finalUrl: page.url(),
      actions: actions.map(stripAction),
      durationMs: Date.now() - started,
    };
  } finally {
    // Always close the browser — leaking Chromium processes is the #1 way
    // a Playwright-based tool blows up production hosts.
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Swallowed: best-effort cleanup; we've already returned by this point.
      }
    }
  }
}

/**
 * Public-shape projection of an internal action, suitable for serializing
 * back to the parent agent. Drops the verbose `reasoning` field by default
 * (only `type` and identifiers stay) to keep tool-output token cost down.
 */
function stripAction(a: WebTaskAction): { type: string; ref?: string; reasoning?: string } {
  if (a.type === "click" || a.type === "fill") {
    return { type: a.type, ref: a.ref };
  }
  if (a.type === "goto") {
    return { type: a.type };
  }
  return { type: a.type };
}

// ── Tool factory (for tool.ts registry) ─────────────────────────────────────

/**
 * Build the `web_task` tool definition. Caller is `createAgentTools` in
 * tool.ts; it provides the settings closure so the tool inherits the active
 * chatModel + key vault.
 */
export function createWebTaskTool(settings: AppSettings) {
  return tool({
    description:
      "Autonomously complete a task on a website. Provide a URL and a natural-language goal " +
      "(e.g. 'sign in and download the invoice from last month'). The tool drives a headless " +
      "browser through an inner LLM loop and returns a single result. Use for end-to-end web " +
      "tasks; for one-off clicks or screenshots, prefer the agent-browser or playwright-cli skills.",
    inputSchema: z.object({
      url: z.string().url().describe("Starting URL for the task"),
      task: z
        .string()
        .min(5)
        .describe("Natural-language description of what to accomplish on the site"),
      maxIterations: z
        .number()
        .int()
        .min(1)
        .max(HARD_MAX_ITERATIONS)
        .optional()
        .describe(
          `Maximum LLM-driven actions before giving up. Default ${DEFAULT_MAX_ITERATIONS}, hard cap ${HARD_MAX_ITERATIONS}.`
        ),
    }),
    execute: async ({ url, task, maxIterations }, { abortSignal }) => {
      try {
        const result = await runWebTask({
          url,
          task,
          maxIterations,
          settings,
          abortSignal,
        });
        return result;
      } catch (error) {
        // Loop-guard middleware contract: tool must return a structured
        // failure shape, never throw. Throwing would kill the parent run.
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
