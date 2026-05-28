/**
 * Local backend auto-detection (PM #43).
 *
 * Probes well-known ports for OpenAI-compatible local inference servers
 * (SGLang, vLLM, Ollama, LM Studio, LocalAI). Used by the startup log
 * (operator sees "SGLang detected at :30000 — using prefix-cache fan-out
 * for MoA") and by future settings-UI hints.
 *
 * Probe shape: `GET <baseUrl>/v1/models` with a 500ms timeout. Servers
 * that respond with HTTP 200 + a JSON shape resembling
 * `{ data: [...] }` are counted as available. Servers that error or
 * timeout are simply marked unavailable — no exceptions propagate.
 *
 * The detection list is intentionally short and predictable. Operators
 * who run on non-default ports configure manually in Settings.
 */
import { assertSafeOutboundUrl } from "@/lib/security/url-guard";

export interface LocalBackendCandidate {
  /** Provider id matching MODEL_PROVIDERS keys. */
  provider: "sglang" | "vllm" | "ollama" | "lmstudio" | "localai";
  /** Human-friendly name for log + UI. */
  name: string;
  /** Default base URL to probe + use. */
  baseUrl: string;
  /** PM #43 — does this backend benefit from `--enable-prefix-caching`? */
  supportsPrefixCache: boolean;
  /** One-line launch hint for the startup log when this backend isn't found. */
  launchHint?: string;
}

export const KNOWN_LOCAL_BACKENDS: LocalBackendCandidate[] = [
  {
    provider: "sglang",
    name: "SGLang",
    baseUrl: "http://localhost:30000",
    supportsPrefixCache: true,
    launchHint:
      "python -m sglang.launch_server --model <model> --port 30000 --enable-prefix-caching",
  },
  {
    provider: "vllm",
    name: "vLLM",
    baseUrl: "http://localhost:8000",
    supportsPrefixCache: true,
    launchHint:
      "python -m vllm.entrypoints.openai.api_server --model <model> --port 8000 --enable-prefix-caching",
  },
  {
    provider: "ollama",
    name: "Ollama",
    baseUrl: "http://localhost:11434",
    supportsPrefixCache: false,
    launchHint: "ollama serve  # then `ollama pull <model>`",
  },
  // LM Studio and LocalAI live under their own provider names in the future
  // when we add UI for them; for now they're advisory probes only.
  {
    provider: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://localhost:1234",
    supportsPrefixCache: false,
  },
  {
    provider: "localai",
    name: "LocalAI",
    baseUrl: "http://localhost:8080",
    supportsPrefixCache: false,
  },
];

export interface DetectionResult {
  candidate: LocalBackendCandidate;
  available: boolean;
  /** When available, how many models the server reports. */
  modelCount?: number;
  /** When unavailable, the error class (timeout / refused / non-200). */
  reason?: "timeout" | "refused" | "non_200" | "non_openai_shape" | "url_blocked";
}

const PROBE_TIMEOUT_MS = 500;

/**
 * Probe a single backend. Never throws.
 */
export async function probeLocalBackend(
  candidate: LocalBackendCandidate,
  signal?: AbortSignal
): Promise<DetectionResult> {
  let safeUrl: URL;
  try {
    safeUrl = assertSafeOutboundUrl(`${candidate.baseUrl}/v1/models`);
  } catch {
    return { candidate, available: false, reason: "url_blocked" };
  }

  const timeoutSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const combined =
    typeof AbortSignal.any === "function" && signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

  try {
    const res = await fetch(safeUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: combined,
    });
    if (!res.ok) {
      return { candidate, available: false, reason: "non_200" };
    }
    const data = (await res.json().catch(() => null)) as
      | { data?: Array<{ id?: string }> }
      | null;
    const modelCount = Array.isArray(data?.data) ? data.data.length : 0;
    if (!data || !Array.isArray(data.data)) {
      return { candidate, available: false, reason: "non_openai_shape" };
    }
    return { candidate, available: true, modelCount };
  } catch (err) {
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError");
    return {
      candidate,
      available: false,
      reason: isAbort ? "timeout" : "refused",
    };
  }
}

/**
 * Probe every known local backend in parallel.
 */
export async function detectLocalBackends(
  signal?: AbortSignal
): Promise<DetectionResult[]> {
  return Promise.all(
    KNOWN_LOCAL_BACKENDS.map((c) => probeLocalBackend(c, signal))
  );
}

/**
 * Operator-facing summary string suitable for startup logs.
 *
 * Sample output:
 *   [LocalBackends] Detected: SGLang (4 models @ :30000, prefix-cache OK), Ollama (12 models @ :11434).
 *                   Not detected: vLLM, LM Studio, LocalAI.
 */
export function formatDetectionSummary(results: DetectionResult[]): string {
  const available = results.filter((r) => r.available);
  const unavailable = results.filter((r) => !r.available);

  const availableParts = available.map((r) => {
    const port = new URL(r.candidate.baseUrl).port || "(default)";
    const cacheNote = r.candidate.supportsPrefixCache
      ? ", prefix-cache OK"
      : "";
    return `${r.candidate.name} (${r.modelCount ?? "?"} models @ :${port}${cacheNote})`;
  });
  const unavailableNames = unavailable.map((r) => r.candidate.name);

  const detectedLine =
    availableParts.length > 0
      ? `Detected: ${availableParts.join(", ")}.`
      : "Detected: none.";
  const notDetectedLine =
    unavailableNames.length > 0
      ? ` Not detected: ${unavailableNames.join(", ")}.`
      : "";

  return `[LocalBackends] ${detectedLine}${notDetectedLine}`;
}
