import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { AgentContext } from "@/lib/agent/types";
import type { AppSettings } from "@/lib/types";
import {
  clearFinishedManagedProcessSessions,
  executeCode,
  killManagedProcessSession,
  listManagedProcessSessions,
  pollManagedProcessSession,
  readManagedProcessSessionLog,
  removeManagedProcessSession,
} from "@/lib/tools/code-execution";
import { installPackages } from "@/lib/tools/install-orchestrator";
import { resolveContextCwd } from "@/lib/tools/tool-paths";

/**
 * Code-execution tool family: code_execution, install_packages, and the
 * managed background-process controller. Registered ONLY when
 * `settings.codeExecution.enabled` — the agent cannot run code it has no
 * tool for (safety gate pinned by `tool.test.ts`). Extracted verbatim from
 * `tool.ts` (§10 decomposition, PR 2).
 */

const CODE_EXEC_MAX_CHARS = 20000;
const CODE_EXEC_MAX_LINES = 800;

function getCurrentUserMessageText(context: AgentContext): string {
  const value = context.data?.currentUserMessage;
  return typeof value === "string" ? value.trim() : "";
}

function userExplicitlyRequestedProcessKill(context: AgentContext): boolean {
  const text = getCurrentUserMessageText(context);
  if (!text) return false;

  const killIntent =
    /\b(stop|terminate|kill|cancel|abort|end|прервать|прерви|остановить|останови|убить|убей|завершить|заверши|отменить|отмени)\b/i;
  const negatedIntent =
    /\b(do not|don't|dont|не)\b.{0,20}\b(stop|terminate|kill|cancel|abort|прерв|останов|убива|заверш|отмен)\b/i;

  if (negatedIntent.test(text)) {
    return false;
  }

  return killIntent.test(text);
}

export function createCodeExecTools(
  context: AgentContext,
  settings: AppSettings
): ToolSet {
  if (!settings.codeExecution.enabled) {
    return {};
  }

  // SECURITY (PM #92) — this whole family (code_execution runs host shell,
  // install_packages runs arbitrary post-install hooks, process spawns
  // children) is arbitrary code execution on the operator's machine. The
  // EXTERNAL path (a Telegram / external-API message → handleExternalMessage →
  // runAgentText) inherits the global toolset with no per-trust-context gate,
  // and `codeExecution.enabled` defaults to TRUE — so without this check a
  // prompt-injection from ANY user of ANY connected bot could drive RCE /
  // secret exfiltration (env is scrubbed, PM #28, but files on disk are not).
  // Deny the family to untrusted triggers unless the operator explicitly
  // accepts the risk. The flag is propagated to subordinate agents so a single
  // `call_subordinate` hop cannot launder an untrusted run into a trusted one.
  if (context.untrustedTrigger && !settings.codeExecution.allowExternalTriggers) {
    console.warn(
      `[Security] code_execution family withheld from an UNTRUSTED (external) trigger for chat ${context.chatId}. ` +
        `A non-operator message must not reach host-shell tools. Set settings.codeExecution.allowExternalTriggers=true ` +
        `to allow it (NOT recommended — this exposes RCE to every user of every connected bot).`
    );
    return {};
  }

  const tools: ToolSet = {};

  tools.code_execution = tool({
    description:
      "Execute code in Python, Node.js, or Shell terminal. Use this to run scripts, manipulate files, and perform tasks. PROACTIVE BEHAVIOR: You are encouraged to install necessary packages (e.g. pip install requests) and run your code to verify it works, BUT ONLY for headless/backend scripts. CRITICAL RESTRICTION: DO NOT EVER run GUI applications, desktop windows, or visual games (e.g. pygame, tkinter, electron). They will crash the headless server and hang the process! For GUI apps, just generate the code and tell the user to run it themselves.",
    inputSchema: z.object({
      runtime: z
        .enum(["python", "nodejs", "terminal"])
        .describe(
          "The runtime to use: 'python' for Python code, 'nodejs' for JavaScript/Node.js code, 'terminal' for shell commands"
        ),
      code: z
        .string()
        .describe("The code to execute"),
      session: z
        .number()
        .default(0)
        .describe(
          "Session ID (0-9). Reuse a session to keep terminal working-directory state between calls. Use different sessions for independent tasks."
        ),
      background: z
        .boolean()
        .default(false)
        .describe(
          "Run execution in background and return immediately with a managed process session id."
        ),
      yield_ms: z
        .number()
        .int()
        .min(10)
        .max(120000)
        .optional()
        .describe(
          "Optional milliseconds to wait before yielding a still-running command to background process management."
        ),
    }),
    execute: async ({ runtime, code, session, background, yield_ms }) => {
      const normalizedCode = code.replace(/\r\n/g, "\n");
      const sanitizedCode = normalizedCode.replace(/\s+$/, "");
      const lineCount = sanitizedCode.length === 0 ? 0 : sanitizedCode.split("\n").length;
      if (sanitizedCode.length === 0) {
        return "[Preflight error] Empty code payload.";
      }
      if (sanitizedCode.length > CODE_EXEC_MAX_CHARS) {
        return `[Preflight error] Code payload too large (${sanitizedCode.length} chars). Limit is ${CODE_EXEC_MAX_CHARS}. Split the task into smaller executions.`;
      }
      if (lineCount > CODE_EXEC_MAX_LINES) {
        return `[Preflight error] Code payload has too many lines (${lineCount}). Limit is ${CODE_EXEC_MAX_LINES}. Split the task into smaller executions.`;
      }
      const cwd = resolveContextCwd(context);
      return executeCode(runtime, sanitizedCode, session, settings.codeExecution, cwd, {
        background,
        yieldMs: typeof yield_ms === "number" ? yield_ms : undefined,
      });
    },
  });

  tools.install_packages = tool({
    description:
      "Install dependencies with installer fallback logic. Supports node (npm/pnpm/yarn/bun), python (pip/uv), go, uv, apt (Linux), and brew (macOS/Linuxbrew — use this for system CLIs like nmap/ffmpeg on macOS, where apt is unavailable). Use this when package installation via code_execution is flaky or a command is `not found`.",
    inputSchema: z.object({
      kind: z
        .enum(["auto", "node", "python", "go", "uv", "apt", "brew"])
        .default("auto")
        .describe("Dependency ecosystem to install for. Use `brew` for system CLIs on macOS, `apt` on Debian/Ubuntu."),
      packages: z
        .array(z.string())
        .min(1)
        .describe("List of package names/specifiers to install."),
      prefer_manager: z
        .string()
        .optional()
        .describe("Optional preferred manager (e.g. pnpm, npm, pip, uv, go, apt-get)."),
      global: z
        .boolean()
        .default(false)
        .describe("Whether to install globally when supported (mainly node ecosystem)."),
      timeout_seconds: z
        .number()
        .int()
        .min(1)
        .max(1800)
        .default(600)
        .describe("Timeout per installer attempt in seconds."),
    }),
    execute: async ({ kind, packages, prefer_manager, global, timeout_seconds }) => {
      const cwd = resolveContextCwd(context);
      return installPackages({
        kind,
        packages,
        preferManager: prefer_manager,
        global,
        cwd,
        timeoutMs: timeout_seconds * 1000,
      });
    },
  });

  tools.process = tool({
    description:
      "Manage code_execution background sessions (list, poll, log, kill, clear, remove). Use this after code_execution returns a managed session id.",
    inputSchema: z.object({
      action: z
        .enum(["list", "poll", "log", "kill", "clear", "remove"])
        .describe("Process management action."),
      session_id: z
        .string()
        .optional()
        .describe("Managed process session id for poll/log/kill/remove."),
      timeout_ms: z
        .number()
        .int()
        .min(0)
        .max(120000)
        .optional()
        .describe("Optional wait timeout for poll action."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Optional line offset for log action."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe("Optional line count for log action."),
    }),
    execute: async ({ action, session_id, timeout_ms, offset, limit }) => {
      if (action === "list") {
        return {
          success: true,
          sessions: listManagedProcessSessions(),
        };
      }
      if (action === "poll") {
        if (!session_id?.trim()) {
          return { success: false, error: "session_id is required for poll." };
        }
        return pollManagedProcessSession(session_id, timeout_ms);
      }
      if (action === "log") {
        if (!session_id?.trim()) {
          return { success: false, error: "session_id is required for log." };
        }
        return readManagedProcessSessionLog(session_id, offset, limit);
      }
      if (action === "kill") {
        if (!session_id?.trim()) {
          return { success: false, error: "session_id is required for kill." };
        }
        if (!userExplicitlyRequestedProcessKill(context)) {
          return {
            success: false,
            error:
              "Kill blocked by policy: only stop a background process when the user explicitly asks to stop/cancel it. Continue with poll/log or wait for completion.",
          };
        }
        return killManagedProcessSession(session_id);
      }
      if (action === "remove") {
        if (!session_id?.trim()) {
          return { success: false, error: "session_id is required for remove." };
        }
        return removeManagedProcessSession(session_id);
      }
      return clearFinishedManagedProcessSessions();
    },
  });

  return tools;
}
