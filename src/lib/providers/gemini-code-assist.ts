/**
 * Gemini Code Assist wire-protocol adapter (extracted from llm-provider.ts, §10 decomposition).
 *
 * Google's Code Assist backend (cloudcode-pa.googleapis.com) speaks a different
 * shape than the standard Gemini API: OAuth project onboarding, a wrapped request
 * envelope, JSON-schema sanitization (a strict subset), 500-retry fallbacks, and
 * an SSE/response unwrap. This module implements that adapter as a `fetch`
 * override (`createGeminiOauthFetch`) plus the pure helpers it composes.
 * llm-provider's `createGeminiNativeOauthModel` wires this fetch into the
 * @ai-sdk/google factory.
 *
 * This is a LEAF: no imports from llm-provider (one-way: llm-provider -> here),
 * so no cycle. Pure helpers are exported for unit testing — this surface was
 * previously untested (the §10 CLI/OAuth/SSE coverage gap).
 */

export const GEMINI_CODE_ASSIST_BASE_URL = "https://cloudcode-pa.googleapis.com";
const GEMINI_CODE_ASSIST_API_VERSION = "v1internal";
const GEMINI_CODE_ASSIST_LOAD_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
];
const GEMINI_CODE_ASSIST_USER_AGENT = "google-api-nodejs-client/9.15.1";
const GEMINI_CODE_ASSIST_SCHEMA_BLOCKLIST = new Set([
  "$id",
  "$schema",
  "$defs",
  "definitions",
  "$ref",
  "examples",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "prefixItems",
]);
const GEMINI_FREE_TIER_ID = "free-tier";
const GEMINI_ONBOARD_MAX_POLLS = 8;
const GEMINI_ONBOARD_POLL_DELAY_MS = 1500;
const geminiProjectIdCache = new Map<string, string | null>();
const geminiSessionIdCache = new Map<string, string>();

export function resolveGeminiCodeAssistPlatform(): "WINDOWS" | "MACOS" | "PLATFORM_UNSPECIFIED" {
  if (process.platform === "win32") {
    return "WINDOWS";
  }
  if (process.platform === "darwin") {
    return "MACOS";
  }
  return "PLATFORM_UNSPECIFIED";
}

function getGeminiEnvProjectId(): string | undefined {
  const candidate = (process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || "").trim();
  return candidate || undefined;
}

export function extractGeminiCodeAssistProjectId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const direct = record.cloudaicompanionProject;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  if (
    direct &&
    typeof direct === "object" &&
    !Array.isArray(direct) &&
    typeof (direct as Record<string, unknown>).id === "string"
  ) {
    const directId = (direct as Record<string, unknown>).id as string;
    if (directId.trim()) {
      return directId.trim();
    }
  }

  const nested = record.response;
  if (
    nested &&
    typeof nested === "object" &&
    !Array.isArray(nested) &&
    (nested as Record<string, unknown>).cloudaicompanionProject &&
    typeof (nested as Record<string, unknown>).cloudaicompanionProject === "object"
  ) {
    const nestedProject = ((nested as Record<string, unknown>).cloudaicompanionProject as Record<string, unknown>).id;
    if (typeof nestedProject === "string" && nestedProject.trim()) {
      return nestedProject.trim();
    }
  }

  return undefined;
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractGeminiCurrentTierId(payload: unknown): string | undefined {
  if (!isPlainRecord(payload)) {
    return undefined;
  }
  const currentTier = payload.currentTier;
  if (!isPlainRecord(currentTier)) {
    return undefined;
  }
  const id = currentTier.id;
  if (typeof id === "string" && id.trim()) {
    return id.trim();
  }
  return undefined;
}

export function extractGeminiDefaultAllowedTierId(payload: unknown): string | undefined {
  if (!isPlainRecord(payload)) {
    return undefined;
  }
  const allowed = payload.allowedTiers;
  if (!Array.isArray(allowed)) {
    return undefined;
  }

  for (const entry of allowed) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const isDefault = entry.isDefault === true;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (isDefault && id) {
      return id;
    }
  }

  for (const entry of allowed) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (id) {
      return id;
    }
  }

  return undefined;
}

export function extractGeminiOperationName(payload: unknown): string | undefined {
  if (!isPlainRecord(payload)) {
    return undefined;
  }
  const name = payload.name;
  if (typeof name === "string" && name.trim()) {
    return name.trim();
  }
  return undefined;
}

async function pollGeminiOnboardOperation(params: {
  endpoint: string;
  operationName: string;
  accessToken: string;
  apiClient: string;
}): Promise<unknown> {
  const operationPath = params.operationName.replace(/^\/+/, "");
  for (let attempt = 0; attempt < GEMINI_ONBOARD_MAX_POLLS; attempt += 1) {
    if (attempt > 0) {
      await sleep(GEMINI_ONBOARD_POLL_DELAY_MS);
    }
    try {
      const response = await fetch(
        `${params.endpoint}/${GEMINI_CODE_ASSIST_API_VERSION}/${operationPath}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${params.accessToken}`,
            accept: "application/json",
            "content-type": "application/json",
            "x-goog-api-client": params.apiClient,
            "user-agent": GEMINI_CODE_ASSIST_USER_AGENT,
          },
        }
      );
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!isPlainRecord(payload)) {
        continue;
      }
      if (payload.done === true || payload.response !== undefined) {
        return payload;
      }
    } catch {
      // Ignore poll failures; caller handles fallback.
    }
  }
  return undefined;
}

export async function resolveGeminiCodeAssistProjectId(params: {
  accessToken: string;
  apiClient: string;
  preferredEndpoint?: string;
}): Promise<string | undefined> {
  const envProject = getGeminiEnvProjectId();
  if (envProject) {
    return envProject;
  }

  const cached = geminiProjectIdCache.get(params.accessToken);
  if (cached !== undefined) {
    return cached || undefined;
  }

  const endpoints = [
    params.preferredEndpoint,
    ...GEMINI_CODE_ASSIST_LOAD_ENDPOINTS,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => normalizeEndpoint(value));

  const deduped = [...new Set(endpoints)];
  const metadataPayload = {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  };

  for (const endpoint of deduped) {
    const loadBody = {
      ...(envProject ? { cloudaicompanionProject: envProject } : {}),
      metadata: {
        ...metadataPayload,
        ...(envProject ? { duetProject: envProject } : {}),
      },
    };

    try {
      const response = await fetch(`${endpoint}/${GEMINI_CODE_ASSIST_API_VERSION}:loadCodeAssist`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${params.accessToken}`,
          accept: "application/json",
          "content-type": "application/json",
          "x-goog-api-client": params.apiClient,
          "user-agent": GEMINI_CODE_ASSIST_USER_AGENT,
        },
        body: JSON.stringify(loadBody),
      });

      if (!response.ok) {
        continue;
      }

      const payload = (await response.json().catch(() => null)) as unknown;
      const projectId = extractGeminiCodeAssistProjectId(payload);
      if (projectId) {
        geminiProjectIdCache.set(params.accessToken, projectId);
        return projectId;
      }

      if (extractGeminiCurrentTierId(payload)) {
        continue;
      }

      const tierId = extractGeminiDefaultAllowedTierId(payload) || GEMINI_FREE_TIER_ID;
      const onboardBody: Record<string, unknown> = {
        tierId,
        metadata: {
          ...metadataPayload,
          ...(envProject && tierId !== GEMINI_FREE_TIER_ID ? { duetProject: envProject } : {}),
        },
      };
      if (envProject && tierId !== GEMINI_FREE_TIER_ID) {
        onboardBody.cloudaicompanionProject = envProject;
      }

      const onboardResponse = await fetch(`${endpoint}/${GEMINI_CODE_ASSIST_API_VERSION}:onboardUser`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${params.accessToken}`,
          accept: "application/json",
          "content-type": "application/json",
          "x-goog-api-client": params.apiClient,
          "user-agent": GEMINI_CODE_ASSIST_USER_AGENT,
        },
        body: JSON.stringify(onboardBody),
      });
      if (!onboardResponse.ok) {
        continue;
      }

      const onboardPayload = (await onboardResponse.json().catch(() => null)) as unknown;
      const onboardProjectId = extractGeminiCodeAssistProjectId(onboardPayload);
      if (onboardProjectId) {
        geminiProjectIdCache.set(params.accessToken, onboardProjectId);
        return onboardProjectId;
      }

      const operationName = extractGeminiOperationName(onboardPayload);
      if (!operationName) {
        continue;
      }

      const finalPayload = await pollGeminiOnboardOperation({
        endpoint,
        operationName,
        accessToken: params.accessToken,
        apiClient: params.apiClient,
      });
      const finalProjectId = extractGeminiCodeAssistProjectId(finalPayload);
      if (finalProjectId) {
        geminiProjectIdCache.set(params.accessToken, finalProjectId);
        return finalProjectId;
      }
    } catch {
      // Ignore discovery errors; we'll proceed without project if needed.
    }
  }

  return undefined;
}

export function parseGeminiModelMethod(pathname: string): {
  modelId: string;
  method: "generateContent" | "streamGenerateContent";
} | null {
  const marker = "/models/";
  const markerIndex = pathname.lastIndexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  const tail = pathname.slice(markerIndex + marker.length);
  const methodIndex = tail.lastIndexOf(":");
  if (methodIndex <= 0) {
    return null;
  }

  const method = tail.slice(methodIndex + 1);
  if (method !== "generateContent" && method !== "streamGenerateContent") {
    return null;
  }

  const modelId = decodeURIComponent(tail.slice(0, methodIndex)).trim();
  if (!modelId) {
    return null;
  }

  return {
    modelId,
    method,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeGeminiCodeAssistSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeGeminiCodeAssistSchema(item));
  }
  if (!isPlainRecord(schema)) {
    return schema;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (GEMINI_CODE_ASSIST_SCHEMA_BLOCKLIST.has(key)) {
      continue;
    }
    if (key === "const") {
      out.enum = [value];
      continue;
    }
    if (
      key === "type" &&
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      const normalizedTypes = value.filter((entry) => entry !== "null");
      out.type = normalizedTypes.length === 1 ? normalizedTypes[0] : normalizedTypes;
      continue;
    }
    if (key === "additionalProperties" && value !== false) {
      continue;
    }
    out[key] = sanitizeGeminiCodeAssistSchema(value);
  }
  return out;
}

export function sanitizeGeminiCodeAssistRequest(requestBody: unknown): Record<string, unknown> {
  if (!isPlainRecord(requestBody)) {
    return {};
  }

  const sanitized: Record<string, unknown> = { ...requestBody };
  const tools = sanitized.tools;
  if (!Array.isArray(tools)) {
    return sanitized;
  }

  sanitized.tools = tools.map((tool) => {
    if (!isPlainRecord(tool)) {
      return tool;
    }
    const functionDeclarations = tool.functionDeclarations;
    if (!Array.isArray(functionDeclarations)) {
      return tool;
    }
    return {
      ...tool,
      functionDeclarations: functionDeclarations.map((declaration) => {
        if (!isPlainRecord(declaration)) {
          return declaration;
        }

        const result: Record<string, unknown> = { ...declaration };
        if ("parameters" in result) {
          result.parameters = sanitizeGeminiCodeAssistSchema(result.parameters);
        }
        if ("parametersJsonSchema" in result) {
          result.parametersJsonSchema = sanitizeGeminiCodeAssistSchema(result.parametersJsonSchema);
        }
        return result;
      }),
    };
  });

  return sanitized;
}

export function buildGeminiCodeAssistRequestBody(params: {
  requestBody: unknown;
  modelId: string;
  projectId?: string;
  sessionId?: string;
}): Record<string, unknown> {
  const body =
    params.requestBody &&
    typeof params.requestBody === "object" &&
    !Array.isArray(params.requestBody)
      ? (params.requestBody as Record<string, unknown>)
      : {};

  const requestBody = {
    ...body,
    ...(typeof body.session_id === "string" && body.session_id.trim()
      ? {}
      : params.sessionId
        ? { session_id: params.sessionId }
        : {}),
  };

  return {
    model: params.modelId,
    ...(params.projectId ? { project: params.projectId } : {}),
    user_prompt_id: crypto.randomUUID(),
    request: requestBody,
  };
}

export function shouldRetryGeminiCodeAssist(response: Response, body: string): boolean {
  if (response.status !== 500) {
    return false;
  }
  const normalized = body.toLowerCase();
  return (
    normalized.includes("internal error encountered") || normalized.includes("\"status\": \"internal\"")
  );
}

export function buildGeminiCodeAssistFallbackBodies(requestBody: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidates: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const pushUnique = (value: Record<string, unknown>) => {
    const signature = JSON.stringify(value);
    if (!seen.has(signature)) {
      seen.add(signature);
      candidates.push(value);
    }
  };

  if ("toolConfig" in requestBody) {
    const withoutToolConfig = { ...requestBody };
    delete withoutToolConfig.toolConfig;
    pushUnique(withoutToolConfig);
  }

  if ("tools" in requestBody || "toolConfig" in requestBody) {
    const withoutTools = { ...requestBody };
    delete withoutTools.toolConfig;
    delete withoutTools.tools;
    pushUnique(withoutTools);
  }

  if (
    "generationConfig" in requestBody ||
    "safetySettings" in requestBody ||
    "labels" in requestBody ||
    "cachedContent" in requestBody
  ) {
    const reducedConfig = { ...requestBody };
    delete reducedConfig.generationConfig;
    delete reducedConfig.safetySettings;
    delete reducedConfig.labels;
    delete reducedConfig.cachedContent;
    pushUnique(reducedConfig);
  }

  const minimal: Record<string, unknown> = {};
  if ("contents" in requestBody) {
    minimal.contents = requestBody.contents;
  }
  if ("systemInstruction" in requestBody) {
    minimal.systemInstruction = requestBody.systemInstruction;
  }
  if (Object.keys(minimal).length > 0) {
    pushUnique(minimal);
  }

  return candidates;
}

function logGeminiCodeAssistAttemptFailure(params: {
  status: number;
  stage: string;
  method: "generateContent" | "streamGenerateContent";
  modelId: string;
  hasProject: boolean;
  body: string;
}): void {
  if (params.status !== 500) {
    return;
  }
  const condensedBody = params.body.replace(/\s+/g, " ").trim().slice(0, 220);
  console.warn(
    `[gemini-cli] Code Assist ${params.method} failed at stage=${params.stage} ` +
      `model=${params.modelId} project=${params.hasProject ? "set" : "missing"} ` +
      `status=${params.status} body=${condensedBody}`
  );
}

export function unwrapGeminiCodeAssistResponse(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const record = payload as Record<string, unknown>;
  const response = record.response;
  if (response !== undefined) {
    return response;
  }

  return payload;
}

export function rewriteGeminiCodeAssistEventData(rawData: string): string {
  const trimmed = rawData.trim();
  if (!trimmed || trimmed === "[DONE]") {
    return rawData;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const unwrapped = unwrapGeminiCodeAssistResponse(parsed);
    return JSON.stringify(unwrapped);
  } catch {
    return rawData;
  }
}

export function rewriteGeminiCodeAssistSseStream(
  stream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      let pendingLine = "";
      let eventDataLines: string[] = [];

      const flushEvent = () => {
        if (eventDataLines.length === 0) {
          return;
        }

        const data = eventDataLines.join("\n");
        eventDataLines = [];
        controller.enqueue(
          encoder.encode(`data: ${rewriteGeminiCodeAssistEventData(data)}\n\n`)
        );
      };

      const processLine = (rawLine: string) => {
        let line = rawLine;
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }

        if (line.startsWith("data:")) {
          eventDataLines.push(line.slice(5).trimStart());
          return;
        }

        if (line.length === 0) {
          flushEvent();
          return;
        }

        controller.enqueue(encoder.encode(`${line}\n`));
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          pendingLine += decoder.decode(value, { stream: true });
          while (true) {
            const newlineIdx = pendingLine.indexOf("\n");
            if (newlineIdx === -1) {
              break;
            }
            const line = pendingLine.slice(0, newlineIdx);
            pendingLine = pendingLine.slice(newlineIdx + 1);
            processLine(line);
          }
        }

        pendingLine += decoder.decode();
        if (pendingLine.length > 0) {
          processLine(pendingLine);
        }
        flushEvent();
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

export type GeminiTokenSource = {
  /** Returns a currently-valid access token, refreshing under the hood. */
  getAccessToken: () => Promise<string>;
  /** Stable per-credential key for the session-id cache (NOT the rotating token). */
  sessionKey?: string;
};

export function createGeminiOauthFetch(token: string | GeminiTokenSource) {
  const getAccessToken =
    typeof token === "string" ? () => Promise.resolve(token) : token.getAccessToken;
  // Key the session id on a STABLE identifier, not the (rotating) access token —
  // a token refresh must not regenerate the conversational session id.
  const sessionKey = typeof token === "string" ? token : token.sessionKey ?? "default";
  const apiClient = `gl-node/${process.versions.node}`;
  const sessionId =
    geminiSessionIdCache.get(sessionKey) || (() => {
      const value = crypto.randomUUID();
      geminiSessionIdCache.set(sessionKey, value);
      return value;
    })();
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const accessToken = await getAccessToken();
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.delete("x-goog-api-key");
    headers.set("authorization", `Bearer ${accessToken}`);
    headers.set("x-goog-api-client", apiClient);
    headers.set("user-agent", GEMINI_CODE_ASSIST_USER_AGENT);

    if (request.method.toUpperCase() !== "POST") {
      return fetch(new Request(request, { headers }));
    }

    const requestUrl = new URL(request.url);
    const parsed = parseGeminiModelMethod(requestUrl.pathname);
    if (!parsed) {
      return fetch(new Request(request, { headers }));
    }

    const rawBody = await request.text();
    if (!rawBody.trim()) {
      return fetch(new Request(request, { headers }));
    }

    let requestBody: unknown;
    try {
      requestBody = JSON.parse(rawBody) as unknown;
    } catch {
      return fetch(
        new Request(request, {
          headers,
          body: rawBody,
        })
      );
    }

    const endpoint = normalizeEndpoint(`${requestUrl.protocol}//${requestUrl.host}`);
    const projectId = await resolveGeminiCodeAssistProjectId({
      accessToken,
      apiClient,
      preferredEndpoint: endpoint,
    });
    const sanitizedRequestBody = sanitizeGeminiCodeAssistRequest(requestBody);
    const targetUrl = `${endpoint}/${GEMINI_CODE_ASSIST_API_VERSION}:${parsed.method}${
      parsed.method === "streamGenerateContent" ? "?alt=sse" : ""
    }`;
    const postCodeAssist = async (innerRequest: Record<string, unknown>) => {
      const wrappedBody = buildGeminiCodeAssistRequestBody({
        requestBody: innerRequest,
        modelId: parsed.modelId,
        projectId,
        sessionId,
      });
      return fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(wrappedBody),
        signal: request.signal,
      });
    };

    let response = await postCodeAssist(sanitizedRequestBody);
    if (!response.ok) {
      const firstErrorText = await response.clone().text().catch(() => "");
      logGeminiCodeAssistAttemptFailure({
        status: response.status,
        stage: "initial",
        method: parsed.method,
        modelId: parsed.modelId,
        hasProject: typeof projectId === "string" && projectId.length > 0,
        body: firstErrorText,
      });
      if (shouldRetryGeminiCodeAssist(response, firstErrorText)) {
        const fallbacks = buildGeminiCodeAssistFallbackBodies(sanitizedRequestBody);
        for (let i = 0; i < fallbacks.length; i += 1) {
          const fallbackRequest = fallbacks[i];
          const retryResponse = await postCodeAssist(fallbackRequest);
          if (retryResponse.ok) {
            response = retryResponse;
            break;
          }
          response = retryResponse;
          const retryErrorText = await retryResponse.clone().text().catch(() => "");
          logGeminiCodeAssistAttemptFailure({
            status: retryResponse.status,
            stage: `fallback-${i + 1}`,
            method: parsed.method,
            modelId: parsed.modelId,
            hasProject: typeof projectId === "string" && projectId.length > 0,
            body: retryErrorText,
          });
          if (!shouldRetryGeminiCodeAssist(retryResponse, retryErrorText)) {
            break;
          }
        }
      }
    }

    if (!response.ok) {
      return response;
    }

    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-length");

    if (parsed.method === "streamGenerateContent") {
      if (!response.body) {
        return response;
      }
      return new Response(rewriteGeminiCodeAssistSseStream(response.body), {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    const responseText = await response.text();
    if (!responseText.trim()) {
      return new Response(responseText, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    try {
      const parsedResponse = JSON.parse(responseText) as unknown;
      return new Response(
        JSON.stringify(unwrapGeminiCodeAssistResponse(parsedResponse)),
        {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        }
      );
    } catch {
      return new Response(responseText, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }
  };
}
