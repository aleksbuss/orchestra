"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AudioLines } from "lucide-react";
import { CodeBlock } from "./code-block";
import { ToolOutput } from "./tool-output";
import type { UIMessage } from "ai";

/** Strip model-internal reasoning blocks from streamed text before rendering. */
function stripThinkingTags(text: string): string {
  if (!text) return text;
  // Remove complete <thinking>...</thinking> blocks
  let result = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  // If a <thinking> block was opened but not yet closed (mid-stream), hide everything from it onwards
  result = result.replace(/<thinking>[\s\S]*/i, "");
  return result.trim();
}

interface MessageBubbleProps {
  message: UIMessage;
}

/**
 * Wrap the rendered bubble in React.memo (PM #33). syncTick from
 * `useBackgroundSync` fires on every SSE pulse — without memoisation, the
 * entire message list re-renders on every tick. For a 500-message chat
 * that's 500 markdown re-parses + 500 highlight.js code-block re-renders
 * every few seconds, even though none of the messages have actually
 * changed.
 *
 * The custom comparator is strict by reference for the message OBJECT plus
 * a `parts.length` shortcut — streaming mid-message produces a new parts
 * array via spread, so the reference check on `message` catches it. For
 * the post-stream "tool-result patched in place" case the AI SDK swaps the
 * entire UIMessage; same reference check catches it. We deliberately do
 * NOT deep-equal — that's MORE expensive than just re-rendering for the
 * very rare case the reference shape changes silently.
 */
export const MessageBubble = memo(MessageBubbleImpl, (prev, next) => {
  // Reference-equal message → no re-render needed.
  return prev.message === next.message;
});

function MessageBubbleImpl({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  // Extract text content from parts
  const textContent = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");

  // Extract tool parts
  const toolParts = message.parts.filter(
    (p) => p.type.startsWith("tool-") || p.type === "dynamic-tool"
  );

  // The agent often emits final answers via the `response` tool with no text part.
  // Surface that output as regular assistant text so the user always sees it.
  const responseToolText = toolParts
    .map((part) => {
      if (part.type === "dynamic-tool") {
        const dp = part as {
          toolName?: string;
          state?: string;
          output?: unknown;
        };
        if (dp.toolName !== "response" || dp.state !== "output-available") return "";
        return typeof dp.output === "string" ? dp.output : JSON.stringify(dp.output ?? "");
      }

      if (!part.type.startsWith("tool-")) return "";
      const tp = part as {
        type: string;
        state?: string;
        output?: unknown;
      };
      const toolName = tp.type.replace("tool-", "");
      if (toolName !== "response" || tp.state !== "output-available") return "";
      return typeof tp.output === "string" ? tp.output : JSON.stringify(tp.output ?? "");
    })
    .filter(Boolean)
    .join("\n\n");

  // Strip <thinking>...</thinking> blocks before rendering (handles mid-stream too)
  const visibleTextContent = stripThinkingTags(textContent || responseToolText);

  return (
    <div className="space-y-1">
      {/* Tool invocations */}
      {toolParts.map((part, idx) => {
        if (part.type === "dynamic-tool") {
          const dp = part as {
            type: "dynamic-tool";
            toolName: string;
            toolCallId: string;
            state: string;
            input?: unknown;
            output?: unknown;
          };
          return (
            <ToolOutput
              key={`tool-${dp.toolCallId}-${idx}`}
              toolName={dp.toolName}
              args={
                typeof dp.input === "object" && dp.input !== null
                  ? (dp.input as Record<string, unknown>)
                  : {}
              }
              result={
                dp.state === "output-available"
                  ? typeof dp.output === "string"
                    ? dp.output
                    : JSON.stringify(dp.output)
                  : dp.state === "output-error"
                    ? "Error occurred"
                    : "Running..."
              }
            />
          );
        }
        // Handle typed tool parts (tool-{name})
        if (part.type.startsWith("tool-")) {
          const tp = part as {
            type: string;
            toolCallId?: string;
            state?: string;
            input?: unknown;
            output?: unknown;
          };
          const toolName = part.type.replace("tool-", "");
          return (
            <ToolOutput
              key={`tool-${tp.toolCallId || idx}-${idx}`}
              toolName={toolName}
              args={
                typeof tp.input === "object" && tp.input !== null
                  ? (tp.input as Record<string, unknown>)
                  : {}
              }
              result={
                tp.state === "output-available"
                  ? typeof tp.output === "string"
                    ? tp.output
                    : JSON.stringify(tp.output)
                  : tp.state === "output-error"
                    ? "Error occurred"
                    : "Running..."
              }
            />
          );
        }
        return null;
      })}

      {/* Text content: Apple-style iMessage layout */}
      {visibleTextContent && isUser && (
        <div className="flex w-full justify-end py-1">
          <div className="bg-gradient-to-br from-blue-500 to-indigo-500 text-white rounded-[20px] rounded-tr-[4px] px-4 py-2 shadow-sm max-w-[85%] sm:max-w-[75%] min-w-0 overflow-hidden break-words">
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{visibleTextContent}</p>
          </div>
        </div>
      )}

      {visibleTextContent && !isUser && (
        <div className="flex w-full justify-start gap-3 py-2 items-start">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-sm mt-1">
            <AudioLines className="size-4" />
          </div>
          <div className="glass-panel shadow-md backdrop-blur-3xl rounded-[24px] rounded-tl-[6px] px-5 py-4 max-w-[90%] sm:max-w-[85%] text-[15px] leading-relaxed min-w-0 overflow-hidden break-words">
            <div className="prose prose-base dark:prose-invert max-w-none text-inherit [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              <MarkdownContent content={visibleTextContent} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || "");
          const isInline = !match;
          if (isInline) {
            return (
              <code
                className="bg-muted px-1.5 py-0.5 rounded text-sm"
                {...props}
              >
                {children}
              </code>
            );
          }
          return (
            <CodeBlock
              code={String(children).replace(/\n$/, "")}
              language={match[1]}
            />
          );
        },
        ul({ children, ...props }) {
          return (
            <ul className="my-2 list-disc pl-6 space-y-1" {...props}>
              {children}
            </ul>
          );
        },
        ol({ children, ...props }) {
          return (
            <ol className="my-2 list-decimal pl-6 space-y-1" {...props}>
              {children}
            </ol>
          );
        },
        li({ children, ...props }) {
          return (
            <li className="marker:text-muted-foreground" {...props}>
              {children}
            </li>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
