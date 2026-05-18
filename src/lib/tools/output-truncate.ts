/**
 * Bound the size of a tool result before it lands in chat history.
 *
 * Why: the autoresearch loop produced tool results of ~50 KB per iteration
 * (full training stdout). Each result was persisted verbatim into the chat
 * JSON, which then has to be re-serialized on every subsequent message
 * (chat-store rewrites the whole file) and re-fed into the model on the next
 * turn. The result was a 376 KB chat file after ~22 minutes and a UI that
 * felt frozen. Truncating to head+tail keeps enough signal for the agent to
 * reason about success/failure while capping the per-message blast radius.
 */

export const TOOL_OUTPUT_HISTORY_LIMIT = 8000;

const TRUNCATION_MARKER = "[…output truncated for chat history; full text was visible to the model at execution time…]";

interface TruncationResult {
  /** String representation suitable for chat persistence and re-injection into model history. */
  content: string;
  /** Was the original value larger than `maxChars`? */
  truncated: boolean;
  /** Original length in characters of the stringified value. */
  originalLength: number;
}

function stringifyForHistory(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Truncate to head + tail with a marker, preserving the start (where commands
 * usually echo their inputs / setup) and the tail (where exit codes / final
 * summaries live). 25% head / 75% tail mirrors how training scripts and
 * shell commands distribute their useful signal.
 */
export function truncateToolOutputForHistory(
  value: unknown,
  maxChars: number = TOOL_OUTPUT_HISTORY_LIMIT
): TruncationResult {
  const text = stringifyForHistory(value);
  if (text.length <= maxChars) {
    return { content: text, truncated: false, originalLength: text.length };
  }

  const budget = Math.max(maxChars - TRUNCATION_MARKER.length - 8, 200);
  const headChars = Math.floor(budget * 0.25);
  const tailChars = budget - headChars;
  const head = text.slice(0, headChars);
  const tail = text.slice(text.length - tailChars);

  return {
    content: `${head}\n\n${TRUNCATION_MARKER}\n[skipped ${text.length - headChars - tailChars} chars]\n\n${tail}`,
    truncated: true,
    originalLength: text.length,
  };
}
