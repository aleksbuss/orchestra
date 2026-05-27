// ============================================================
// Core type definitions for Orchestra
// ============================================================
import { z } from "zod";

// --- Settings ---

export type ChatAuthMethod = "api_key" | "oauth";

export interface ModelConfig {
  provider:
    | "openai"
    | "anthropic"
    | "google"
    | "openrouter"
    | "ollama"
    | "custom"
    | "codex-cli"
    | "gemini-cli";
  model: string;
  apiKey?: string;
  authMethod?: ChatAuthMethod;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AppSettings {
  chatModel: ModelConfig;
  utilityModel: ModelConfig;
  embeddingsModel: {
    provider: "openai" | "openrouter" | "google" | "ollama" | "custom" | "mock";
    model: string;
    apiKey?: string;
    baseUrl?: string;
    dimensions?: number;
  };
  codeExecution: {
    enabled: boolean;
    timeout: number; // seconds
    maxOutputLength: number; // characters
  };
  memory: {
    enabled: boolean;
    similarityThreshold: number; // 0-1
    maxResults: number;
    chunkSize: number; // characters per chunk for knowledge ingestion
  };
  search: {
    enabled: boolean;
    provider: "searxng" | "tavily" | "none";
    apiKey?: string;
    baseUrl?: string;
  };
  /**
   * Post-aggregator reflection loop (PM #38). When enabled, the MoA
   * aggregator output is reviewed by a critic LLM; if the critic flags
   * factual errors / incomplete answers / code bugs / etc, a revisor
   * pass produces a corrected response. Capped at ONE round to bound
   * cost — soft budget banner from PM #36 makes the extra spend visible.
   * Defaults to disabled — opt-in feature.
   */
  reflection?: {
    enabled: boolean;
  };
  general: {
    darkMode: boolean;
    language: string;
  };
  auth: {
    enabled: boolean;
    username: string;
    passwordHash: string;
    mustChangeCredentials: boolean;
  };
  /** Per-provider API key vault. Presets resolve keys from here. */
  providerApiKeys?: Partial<Record<ModelConfig["provider"], string>>;
  /**
   * Read-only map indicating which provider keys are available via
   * `process.env.*` (e.g. `OPENROUTER_API_KEY` in `.env.local`). Populated
   * by `GET /api/settings` for the UI; never persisted. Lets the model
   * wizard show "Key available from environment" instead of pretending no
   * key exists when the user has only configured `.env.local`. See PM #10.
   */
  envApiKeys?: Partial<Record<ModelConfig["provider"], boolean>>;
}

// --- Chat ---

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  toolName?: string;
  toolCallId?: string;
  toolResult?: unknown;
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }>;
  attachments?: Attachment[];
}

export interface Attachment {
  name: string;
  type: string;
  url?: string;
  path?: string;
}

/**
 * Soft per-chat budget tracking (PM #36). Accumulated across every LLM call
 * within this chat — main streamText, MoA Router, MoA proposers, MoA
 * aggregator, reflection, etc. Sums input + output tokens × pricing into a
 * single USD figure for the chat-panel banner.
 *
 * Not a hard cap; the operator can keep chatting even if cost is high.
 * `fullyPriced` is false when any contributing model had unknown pricing —
 * in that case the displayed cost is a lower bound and the UI labels it
 * with a "~" prefix.
 */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** False if at least one recorded LLM call had no pricing entry. */
  fullyPriced: boolean;
}

export interface Chat {
  id: string;
  title: string;
  projectId?: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  /** Cumulative LLM usage across all turns in this chat. PM #36. */
  cumulativeUsage?: ChatUsage;
}

export const AttachmentSchema = z.object({
  name: z.string(),
  type: z.string(),
  url: z.string().optional(),
  path: z.string().optional(),
});

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  createdAt: z.string(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  toolResult: z.unknown().optional(),
  toolCalls: z.array(z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.record(z.string(), z.unknown()),
  })).optional(),
  attachments: z.array(AttachmentSchema).optional(),
});

export const ChatUsageSchema = z.object({
  promptTokens: z.number().nonnegative(),
  completionTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  fullyPriced: z.boolean(),
});

export const ChatSchema = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string().optional(),
  messages: z.array(ChatMessageSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  cumulativeUsage: ChatUsageSchema.optional(),
});

export interface ChatListItem {
  id: string;
  title: string;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** File uploaded to a specific chat session */
export interface ChatFile {
  name: string;
  path: string;       // full absolute path
  size: number;
  type: string;       // MIME type or extension
  uploadedAt: string;
}

// --- Projects ---

export interface Project {
  id: string;
  name: string;
  description: string;
  instructions: string;
  memoryMode: "global" | "isolated";
  createdAt: string;
  updatedAt: string;
  /**
   * Absolute filesystem path the agent should treat as this project's working
   * directory. Set ONLY for "linked" projects (Open Folder feature) — projects
   * pointing at an existing real-world repo on disk. When undefined the project
   * is a sandbox, and `getWorkDir` falls back to `data/projects/<id>/`.
   *
   * Project metadata (`.meta/skills`, `.meta/mcp`, blackboard) ALWAYS lives
   * under `data/projects/<id>/.meta/` regardless of `absoluteRoot`. We do not
   * pollute the user's repository with Orchestra internals.
   */
  absoluteRoot?: string;
}

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  memoryMode: z.enum(["global", "isolated"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  absoluteRoot: z.string().optional(),
});

/**
 * Project Skill (Agent Skills spec: https://agentskills.io/specification).
 * Each skill is a directory under .meta/skills/<skill-name>/ with SKILL.md.
 */
export interface ProjectSkill {
  /** Matches directory name; lowercase, hyphens, 1–64 chars */
  name: string;
  /** What the skill does and when to use it; 1–1024 chars */
  description: string;
  /** Markdown body of SKILL.md (instructions) */
  body: string;
  /** Optional fields from frontmatter */
  license?: string;
  compatibility?: string;
  /** Path to skill directory (for references/scripts/assets) */
  skillDir: string;
}

/** Skill metadata only (for system prompt; full body loaded on activate). */
export interface ProjectSkillMetadata {
  name: string;
  description: string;
  skillDir: string;
}

// --- Goals & Autopilot ---

export type GoalTaskStatus = "pending" | "in_progress" | "completed" | "failed";

export interface GoalTask {
  id: string; // e.g. "1.1" or "2"
  description: string;
  status: GoalTaskStatus;
  subtasks?: GoalTask[];
  result?: string;
}

export interface ProjectGoal {
  id: string;
  projectId: string; // 'none' for global
  chatId: string;    // Binds the goal to the specific chat context
  title: string;
  description: string;
  tasks: GoalTask[];
  status: "active" | "completed" | "paused";
  createdAt: string;
  updatedAt: string;
}

// --- Memory ---

export enum MemoryArea {
  MAIN = "main",
  FRAGMENTS = "fragments",
  SOLUTIONS = "solutions",
  INSTRUMENTS = "instruments",
}

export interface MemoryEntry {
  id: string;
  text: string;
  area: MemoryArea;
  metadata: Record<string, unknown>;
  score?: number;
  createdAt: string;
}

export interface VectorDocument {
  id: string;
  text: string;
  embedding: number[];
  metadata: Record<string, unknown>;
}

// --- Knowledge ---

export interface KnowledgeFile {
  path: string;
  name: string;
  type: string;
  size: number;
  checksum: string;
  state: "new" | "original" | "changed" | "removed";
  documentIds: string[];
}

// --- Agent ---

export interface AgentConfig {
  chatModel: ModelConfig;
  utilityModel: ModelConfig;
  embeddingsModel: AppSettings["embeddingsModel"];
  memorySubdir: string;
  knowledgeSubdirs: string[];
  projectId?: string;
}

export interface ToolCall {
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  output: string;
  breakLoop?: boolean;
}

// --- Code Execution ---

export interface ShellSession {
  id: number;
  pid?: number;
  isRunning: boolean;
  lastOutput: string;
}

export interface CodeExecutionResult {
  output: string;
  exitCode?: number;
  error?: string;
}

// --- MCP (Model Context Protocol) ---

/** Normalized project MCP config (after parsing). */
export interface ProjectMcpConfig {
  servers: McpServerConfig[];
}

export type McpServerConfig =
  | McpServerConfigStdio
  | McpServerConfigHttp;

export interface McpServerConfigStdio {
  id: string;
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpServerConfigHttp {
  id: string;
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

/**
 * Cursor-compatible format for .meta/mcp/servers.json.
 * Key = server id; value with `command` = stdio, with `url` = http.
 * @see https://docs.cursor.com/context/model-context-protocol
 */
export interface McpServersFileCursor {
  mcpServers: Record<
    string,
    | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
    | { url: string; headers?: Record<string, string> }
  >;
}

export const McpServerConfigStdioSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

export const McpServerConfigHttpSchema = z.object({
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
});

export const McpServersFileCursorSchema = z.object({
  mcpServers: z.record(
    z.string(),
    z.union([McpServerConfigStdioSchema, McpServerConfigHttpSchema])
  ),
});

// --- API ---

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
