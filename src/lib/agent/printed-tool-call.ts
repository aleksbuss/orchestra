/**
 * Printed-tool-call detection — the pure string layer.
 *
 * Extracted from `agent-response.ts` (PM #134) so the recovery LADDER
 * (`final-answer-failover.ts`) can run the same gate its call sites run.
 * `agent-response.ts` imports the ladder, so the ladder importing the gate back
 * out of `agent-response.ts` would be a runtime cycle — invisible in dev, and
 * `undefined` exports in a production chunk (`import-cycle-contract.test.ts`
 * fails it). A leaf module both can import is the way out.
 *
 * Everything here is a PURE function of a string. No imports, no I/O, no
 * settings, no model. Keep it that way: this module is imported by the agent
 * hot path, the recovery ladder, and the persistence layer alike.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Strip thinking block from text to prevent leaking it to the user UI
 */
export function stripThinkingTags(text: string): string {
  if (!text) return text;
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}

/**
 * Convert AI SDK ModelMessage to our ChatMessage format for storage.
 * Tool messages can contain multiple tool results, so this returns an array.
 */
/**
 * PM #61 — Models frequently emit the final `response` tool call as TEXT (a
 * JSON code block like `{"call":"response","arguments":{"message":"..."}}`)
 * instead of a native tool call — especially under heavy context (MoA) or on
 * mid-tier models. Orchestra has no parser for that, so the real answer gets
 * persisted as a raw JSON blob and the UI renders "no answer". This unwraps
 * that shape and returns the inner message; non-matching text passes through
 * unchanged (conservative — only unwraps when the WHOLE text is the call).
 */
export function unwrapSerializedResponseCall(text: string): string {
  if (!text) return text;
  // PM #81 — the response call may arrive wrapped in RAW tool-call markup
  // (`<tool_call>{…}</tool_call>`, `<function=response>{…}`, `[TOOL_CALLS]…`),
  // not just a bare JSON blob. extractHallucinatedToolCall normalizes every
  // shape; recover the inner message when the mis-emitted call is `response`.
  const markupCall = extractHallucinatedToolCall(text);
  if (markupCall && markupCall.name === "response") {
    const recovered = readResponseMessage(markupCall.args);
    if (recovered) return recovered;
  }
  if (!text.includes("response")) return text;
  let body = text.trim();
  // Strip a single surrounding ```json ... ``` (or bare ```) fence.
  const fence = body.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence) body = fence[1].trim();
  if (!body.startsWith("{") || !body.endsWith("}")) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return text;
  }
  const rec = asRecord(parsed);
  if (!rec) return text;
  const toolName = rec.call ?? rec.name ?? rec.tool ?? rec.function;
  if (toolName !== "response") return text;
  const args =
    asRecord(rec.arguments) ?? asRecord(rec.input) ?? asRecord(rec.parameters) ?? rec;
  const message =
    typeof args.message === "string"
      ? args.message
      : typeof args.text === "string"
        ? args.text
        : typeof args.answer === "string"
          ? args.answer
          : null;
  return message && message.trim() ? message : text;
}

/**
 * PM #81 — a tool call the model emitted as RAW TEXT instead of a native tool
 * call. Degraded models (notably Qwen via Ollama/OpenRouter under long context)
 * stop using the native tool-calling channel and PRINT the call as markup:
 *   - Qwen/Hermes:   `<tool_call>{"name":"t","arguments":{…}}</tool_call>`
 *   - Functionary:   `<function=t>{…}</function>` or `<function=t><parameter=k>v</parameter>`
 *   - Mistral:       `[TOOL_CALLS]{…}` / `[TOOL_CALLS][{…}]`
 *   - bare JSON:     `{"name":"response",…}` ONLY (PM #61) — see branch 4 for why
 *                    action tools require markup, never ambiguous bare JSON.
 * Orchestra only ever parsed the `response`-tool JSON shape
 * (`unwrapSerializedResponseCall`), so ANY other such call was persisted
 * verbatim — the user saw XML garbage and the intended action never ran.
 *
 * Returns the normalized `{ name, args, raw }` when the WHOLE trimmed text is a
 * single such call, else null. Conservative on purpose: an answer that merely
 * quotes `<tool_call>` inside surrounding prose must NOT match (a false positive
 * would suppress a real answer), so the markup must DOMINATE the message — every
 * branch below anchors with `^…$`.
 */
export interface HallucinatedToolCall {
  name: string;
  args: Record<string, unknown>;
  /** The matched markup span (for "does this dominate the message" checks). */
  raw: string;
}

/** Strip ONE surrounding ```lang … ``` fence; no fence ⇒ returned unchanged. */
function stripOneCodeFence(s: string): string {
  const fence = s.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```$/);
  return fence ? fence[1].trim() : s;
}

/** Read a final-answer string out of a `response`-call arg bag. */
function readResponseMessage(args: Record<string, unknown>): string | null {
  for (const key of ["message", "text", "answer", "response", "content"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * Parse a JSON tool-call object (or a single-element array of them) into
 * `{ name, args }`. Handles the OpenAI nested `{ function: { name, arguments } }`
 * shape and an `arguments` field that is itself a JSON STRING. Returns null when
 * no tool name can be resolved.
 */
function parseCallObject(
  jsonText: string
): { name: string; args: Record<string, unknown> } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.trim());
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) parsed = parsed[0];
  const rec = asRecord(parsed);
  if (!rec) return null;

  // OpenAI-style nesting: { type:"function", function:{ name, arguments } }.
  const fnRec = asRecord(rec.function);
  const name: unknown =
    fnRec && typeof fnRec.name === "string"
      ? fnRec.name
      : (rec.name ?? rec.tool ?? rec.call ?? rec.function);
  if (typeof name !== "string" || !name.trim()) return null;

  const rawArgs =
    (fnRec ? fnRec.arguments ?? fnRec.parameters : undefined) ??
    rec.arguments ??
    rec.input ??
    rec.parameters;
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === "string") {
    // OpenAI serializes arguments as a JSON string.
    try {
      args = asRecord(JSON.parse(rawArgs)) ?? {};
    } catch {
      args = {};
    }
  } else {
    args = asRecord(rawArgs) ?? {};
  }
  return { name: name.trim(), args };
}

/**
 * Extract the first BALANCED `{…}` JSON object from the start of `s` (ignoring a
 * leading run of whitespace), discarding any trailing junk (`</function>`,
 * `</tool_call>`, prose). Returns `s` unchanged when it doesn't start with `{`
 * or the braces never balance — letting the caller's JSON.parse fail cleanly.
 */
function extractLeadingJson(s: string): string {
  const str = s.trimStart();
  if (!str.startsWith("{")) return str;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return str.slice(0, i + 1);
    }
  }
  return str;
}

export function extractHallucinatedToolCall(
  text: string
): HallucinatedToolCall | null {
  if (!text) return null;
  // Defang ONE fully-enclosing ```lang … ``` fence (a fenced block is a teaching
  // example, not the model's actual call). Leading/trailing prose is otherwise
  // ALLOWED below: the real long-context degradation is "Let me update X:\n\n
  // <tool_call>…" — prose, then the call — so anchoring to `^…$` (as the first
  // cut did) missed every real case (PM #81 deep-audit against chat a8e1a43c).
  const body = stripOneCodeFence(text.trim());
  if (!body) return null;

  // 1) Functionary form: `<function=NAME>` followed by `<parameter=…>` pairs or a
  //    `{json}` body. This covers the dominant real degradation
  //    `…<tool_call>\n<function=write_text_file>\n<parameter=file_path>…` (nested,
  //    prose-prefixed, often UNCLOSED to EOF) AND standalone `<function=…>{…}`.
  //    `<function=NAME>` immediately followed by a parameter/JSON body is
  //    unambiguous — normal prose never contains it — so we SEARCH (prose before
  //    it is fine) yet require the body so a bare mention never matches.
  const fn = body.match(/<function=([A-Za-z0-9_.\-]+)\s*>/i);
  if (fn) {
    const after = body.slice((fn.index ?? 0) + fn[0].length).trimStart();
    if (after.startsWith("<parameter=")) {
      const args: Record<string, unknown> = {};
      // A value runs until </parameter>, the next <parameter=, a closing
      // </function>/</tool_call>, or EOF (the real blocks are unclosed).
      for (const p of after.matchAll(
        /<parameter=([A-Za-z0-9_.\-]+)\s*>([\s\S]*?)(?=<\/parameter>|<parameter=|<\/function>|<\/tool_call>|$)/gi
      )) {
        args[p[1]] = p[2].trim();
      }
      return { name: fn[1], args, raw: body };
    }
    if (after.startsWith("{")) {
      const rec = (() => {
        try {
          return asRecord(JSON.parse(extractLeadingJson(after)));
        } catch {
          return null;
        }
      })();
      return { name: fn[1], args: rec ?? {}, raw: body };
    }
  }

  // 2) Qwen/Hermes `<tool_call>{json}</tool_call>` (closing optional; leading
  //    prose allowed). A bare `<tool_call>` MENTION (no `{`/`<function=` after)
  //    never matches — that distinguishes a real call from prose ABOUT one.
  const tc = body.match(/<tool_call>\s*(\{[\s\S]*)$/i);
  if (tc) {
    const call = parseCallObject(extractLeadingJson(tc[1]));
    if (call) return { ...call, raw: body };
  }

  // 3) Mistral `[TOOL_CALLS] <json>` (object or single-element array).
  const mistral = body.match(/\[TOOL_(?:CALLS?|REQUEST)\]\s*(\[?\s*\{[\s\S]*)$/i);
  if (mistral) {
    const call = parseCallObject(mistral[1]);
    if (call) return { ...call, raw: body };
  }

  // 4) DeepSeek (PM #82-followup): the model prints its OWN chat-template tokens —
  //    `<｜tool▁call▁begin｜>function<｜tool▁sep｜>NAME\n```json\n{args}```` (one or more,
  //    inside a `<｜tool▁calls▁begin｜>` wrapper). Verified live: deepseek-chat printed exactly
  //    this for `write_text_file` and Orchestra detected NOTHING (no other branch matches
  //    `<tool_call_begin>` — branch 2 needs a literal `<tool_call>`). The NAME is in the
  //    `tool_sep` TOKEN, NOT inside the JSON (the JSON is ARGS-ONLY), so a toolset/name-field
  //    generalization cannot catch this — an explicit branch is required (both doubt reviewers).
  //    Canonical tokens use unicode bars (｜ U+FF5C, ▁ U+2581); a degraded model may emit an
  //    ASCII-ish variant — match BOTH. Require call-begin + sep + NAME + a `{` body (structural
  //    anchor) so prose merely DISCUSSING the format never matches. Args parsed best-effort and
  //    NEVER executed — they only trigger a re-prompt (PM #80), so a parse miss is harmless.
  //    Multi-call blocks: only the FIRST call is recovered (the whole markup message is dropped).
  const ds = body.match(
    /tool[_▁]call[_▁]begin[\s\S]{0,60}?tool[_▁]sep[^A-Za-z0-9]*([A-Za-z0-9_.\-]+)[\s\S]*?(\{[\s\S]*)$/i
  );
  if (ds) {
    const rec = (() => {
      try {
        return asRecord(JSON.parse(extractLeadingJson(ds[2])));
      } catch {
        return null;
      }
    })();
    return { name: ds[1], args: rec ?? {}, raw: body };
  }

  // 6) Claude/dots XML form: `<invoke name="NAME"><parameter name="KEY">VALUE</parameter>…</invoke>`,
  //    optionally wrapped in `<dots_function_call>` / `<function_calls>`. Verified LIVE
  //    (chat 9891bb43, 2026-08-18): `dots-studio/dots-3-note-preview:free` printed exactly
  //    `<dots_function_call>\n<invoke name="write_text_file">\n<parameter name="file_path">…`
  //    as its FINAL message and Orchestra detected NOTHING, so PM #69 forced a blank answer
  //    over 18 KB of XML garbage — TWICE. Branch 1 (Functionary) cannot catch this: it needs
  //    `<function=NAME>` (equals sign, name IN the tag), whereas this form puts the name in a
  //    `name="…"` ATTRIBUTE and uses `<parameter name="…">` pairs. Anchor on the invoke tag AND
  //    a real block boundary (`</invoke>` or a `<parameter name=`) so prose that merely names
  //    the syntax (e.g. a correction message) never matches.
  const inv = body.match(/<invoke\s+name\s*=\s*["']([A-Za-z0-9_.\-]+)["']\s*>/i);
  if (inv && /<\/(?:antml:)?invoke>|<parameter\s+name\s*=/i.test(body)) {
    const after = body.slice((inv.index ?? 0) + inv[0].length);
    const args: Record<string, unknown> = {};
    for (const p of after.matchAll(
      /<parameter\s+name\s*=\s*["']([A-Za-z0-9_.\-]+)["']\s*>([\s\S]*?)(?=<\/parameter>|<parameter\s+name|<\/(?:antml:)?invoke>|<\/dots_function_call>|<\/function_calls>|$)/gi
    )) {
      args[p[1]] = p[2].trim();
    }
    return { name: inv[1], args, raw: body };
  }

  // 6b) dots NAME-AS-TAG variant (found 2026-09-06 in a Free Mode long run).
  //    `dots-studio/dots-3-note-preview:free` prints the tool name as the TAG
  //    ITSELF inside the wrapper — verbatim from the chat store:
  //      `<dots_function_call>\n<code_execution">\n<parameter name="runtime">…`
  //    — a stray `">`, NO `<invoke`, NO `name=` attribute. Branch 6 needs
  //    `<invoke name="…">`, so this matched NOTHING: `extractHallucinatedToolCall`
  //    returned null, the prose preamble made `turnHasDeliverableAnswer` true, the
  //    recovery net was skipped, and 16 KB of raw XML shipped to the user. In one
  //    6-turn run the log had 24 of this variant vs 6 of the detected `<invoke>`
  //    form — the undetected shape DOMINATES for this model.
  //
  //    Per the protake council: do NOT anchor on the tool-name tag (its quoting
  //    is the malformed part — `"?` is brittle and mis-parses attributes /
  //    `<name>` / `<name attr=…>`). Anchor on the WELL-FORMED signal instead —
  //    a known wrapper plus a `<parameter name="…">` — and read the tool name
  //    from the nearest preceding element tag that is not the wrapper/parameter/
  //    invoke. Structure-only (no tool registry) to keep this pure like the other
  //    branches; a fenced example is already stripped above. Classification only:
  //    args are parsed for the re-prompt, NEVER executed (executing text recovered
  //    from an untrusted transcript is the injection surface the council flagged).
  const dotsWrapper = /<(?:dots_function_call|function_calls)>/i.test(body);
  const firstParamIdx = dotsWrapper
    ? body.search(/<parameter\s+name\s*=\s*["']/i)
    : -1;
  if (firstParamIdx > 0) {
    const preceding = [
      ...body.slice(0, firstParamIdx).matchAll(/<([A-Za-z_][A-Za-z0-9_.\-]*)\b[^>]*>/gi),
    ]
      .map((m) => m[1])
      .filter(
        (n) => !/^(?:dots_function_call|function_calls|invoke|parameter)$/i.test(n)
      );
    const name = preceding[preceding.length - 1];
    // `response` printed as text stays "recoverable to prose" (delivered=true) —
    // same carve-out as every other branch; only an ACTION tool flips delivered.
    if (name && name.toLowerCase() !== "response") {
      const after = body.slice(firstParamIdx);
      const args: Record<string, unknown> = {};
      for (const p of after.matchAll(
        /<parameter\s+name\s*=\s*["']([A-Za-z0-9_.\-]+)["']\s*>([\s\S]*?)(?=<\/parameter>|<parameter\s+name|<\/(?:antml:)?invoke>|<\/dots_function_call>|<\/function_calls>|$)/gi
      )) {
        args[p[1]] = p[2].trim();
      }
      return { name, args, raw: body };
    }
  }

  // 5) bare JSON blob (no markup) — ONLY the `response` serialization (PM #61).
  //    Bare JSON is too ambiguous to treat as an ACTION-tool call: a legitimate
  //    final answer can BE bare JSON (e.g. "reply with only the tool-call JSON,
  //    no prose"), and the detect/suppress path would then DELETE that answer.
  //    For `response` a false match is harmless — it just recovers the message
  //    as prose. So bare JSON matches `response` only; every other tool requires
  //    the unambiguous markup of branches 1–3.
  if (body.startsWith("{") && body.endsWith("}")) {
    const call = parseCallObject(body);
    if (call && call.name === "response") {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      const rec = asRecord(parsed);
      const hasArgsContainer = !!(
        rec &&
        ("arguments" in rec ||
          "input" in rec ||
          "parameters" in rec ||
          asRecord(rec.function))
      );
      if (hasArgsContainer) return { ...call, raw: body };
    }
  }

  return null;
}

/**
 * PM #109 (3rd follow-up) — the NAME of a printed ACTION tool call in `text`,
 * whether or not its body PARSES.
 *
 * `extractHallucinatedToolCall` requires the Qwen/Hermes `<tool_call>{…}` and
 * Mistral `[TOOL_CALLS]…` bodies to parse as JSON, so it MISSES a call whose JSON
 * is broken or truncated. That gap shipped raw markup to a user (chat 9891bb43):
 * the forced-answer output cap (PM #109 part 1) truncated a `<tool_call>{"name":
 * "write_text_file", …}` blob mid-string → the JSON no longer parsed → the
 * residual gate saw "no tool call" and delivered the raw markup. A truncated
 * printed call is STILL a printed call; shipping it is never right.
 *
 * So: try the strict parser first (covers every dialect, incl. `<invoke>` /
 * `<function=>` which don't need JSON), then fall back to a STRUCTURAL match for
 * the two JSON-bodied dialects — a `name` field naming a non-`response` tool
 * right after the opener. The `"name"`-adjacency keeps prose that merely mentions
 * `<tool_call>` from matching. Returns null when nothing actionable is printed.
 */
export function printedActionCallName(text: string): string | null {
  const parsed = extractHallucinatedToolCall(text);
  if (parsed) return parsed.name === "response" ? null : parsed.name;
  const body = text.trim();
  const structural =
    body.match(
      /<tool_call>\s*\{[\s\S]{0,160}?["']name["']\s*:\s*["']([A-Za-z0-9_.\-]+)["']/i
    ) ||
    body.match(
      /\[TOOL_(?:CALLS?|REQUEST)\][\s\S]{0,160}?["']name["']\s*:\s*["']([A-Za-z0-9_.\-]+)["']/i
    );
  if (structural) {
    return structural[1].toLowerCase() === "response" ? null : structural[1];
  }
  return null;
}

/** The verdict on one forced (tool-less) answer — see `gateForcedAnswer`. */
export type ForcedAnswerGate =
  | { degraded: false; toolName: null; text: string }
  | { degraded: true; toolName: string; text: string };

/**
 * PM #132 — the ONE gate every forced (tool-less) answer passes before it is
 * shown or persisted.
 *
 * `generateFinalAnswerWithFailover` has three call sites and each was free to
 * post-process its output by hand. Two did; `primary-stream-recovery.ts` did
 * not, and shipped a substitute's three printed `<function=search_web>` blocks
 * straight into the chat (live, chat 560896d7, 2026-09-06). That module's own
 * header already warned about this exact drift — the shared *instruction* had
 * been extracted into `finalAnswerInstruction`, the shared *output gate* never
 * was. This is that extraction.
 *
 * DETECTION ONLY, deliberately: it reports what the text IS and returns the
 * cleaned text, and leaves POLICY (record telemetry? swap in a notice? abandon
 * the turn?) to each call site, which genuinely differ. Folding policy in here
 * would rebuild the same drift trap one level up.
 *
 * Pipeline order is load-bearing and must not be reshuffled:
 *   1. `stripThinkingTags` — a reasoning block is never shown to the user, and
 *      markup QUOTED inside one was never a real call, so it must not trip the
 *      gate.
 *   2. `unwrapSerializedResponseCall` — a mis-emitted `response` call IS the
 *      answer; recovering it must happen before anything judges the text.
 *   3. `.trim()`, then `printedActionCallName` — which tolerates a TRUNCATED
 *      JSON body (PM #109: the output cap can cut a `<tool_call>{…}` blob
 *      mid-string, and a parse-strict check then waves the raw markup through).
 *
 * The result is that the string judged is byte-for-byte the string the caller
 * persists — validating one representation and storing another is how markup
 * slips past a gate that "ran".
 */
export function gateForcedAnswer(raw: string): ForcedAnswerGate {
  const text = unwrapSerializedResponseCall(stripThinkingTags(raw ?? "")).trim();
  const toolName = printedActionCallName(text);
  return toolName
    ? { degraded: true, toolName, text }
    : { degraded: false, toolName: null, text };
}
