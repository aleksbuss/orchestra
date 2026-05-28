/**
 * Hardware fingerprinting + MoA configuration recommendations (PM #44).
 *
 * Why this exists: power users with their own GPUs are Orchestra's primary
 * audience for the local-first story. But "I have a 4090, what should I
 * run?" has no obvious answer without manually researching Qwen / Llama
 * variants vs VRAM headroom. This module probes the host (OS, arch, RAM,
 * GPU when accessible) and outputs three opinionated MoA configs the
 * operator can paste into Settings.
 *
 * Detection is best-effort and never throws — a host with no NVIDIA GPU
 * just returns `{ gpu: undefined }` and the recommendations skip the
 * GPU-dependent tiers.
 *
 * Recommendations are conservative — they target Q4_K_M quantization
 * (4-bit, the practical sweet-spot for consumer hardware) and Qwen2.5
 * model family (best-in-class OSS as of 2026-05, validated on Orchestra's
 * MoA workloads in audit testing). When the model landscape moves, this
 * file is the single place to update.
 */
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface HardwareFingerprint {
  /** "darwin" | "linux" | "win32" | other. */
  platform: NodeJS.Platform;
  /** "arm64" | "x64" | other. */
  arch: string;
  cpuCount: number;
  /** Total RAM in GB (rounded to 1 decimal). */
  ramGB: number;
  /** True for Apple Silicon (unified memory architecture). */
  appleSilicon: boolean;
  /** Present when nvidia-smi succeeded; absent otherwise. */
  gpu?: {
    vendor: "nvidia";
    name: string;
    vramGB: number;
  };
}

export interface MoARecommendation {
  /** Short label for the tier — speed / balanced / quality. */
  tier: "speed" | "balanced" | "quality";
  /** Model id (matches the upstream chat-completions catalog). */
  proposerModel: string;
  /** Aggregator may be the same model or larger. */
  aggregatorModel: string;
  /** Quantization hint (e.g., "Q4_K_M" — operator launches the server with it). */
  quantization: string;
  /** Recommended local backend ("sglang" or "vllm" or "ollama"). */
  backend: "sglang" | "vllm" | "ollama";
  /** Rough wall-clock per Swarm turn expectation on this hardware. */
  expectedLatency: string;
  /** Why this tier was suggested. */
  rationale: string;
}

export interface HardwareReport {
  fingerprint: HardwareFingerprint;
  recommendations: MoARecommendation[];
  /** Human-readable single-paragraph note explaining what's running and why. */
  summary: string;
}

/**
 * Probe NVIDIA GPU via nvidia-smi. Returns null if nvidia-smi isn't
 * available or the parse fails. Never throws.
 */
async function detectNvidiaGpu(): Promise<HardwareFingerprint["gpu"] | null> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=memory.total,name", "--format=csv,noheader,nounits"],
      { timeout: 2000 }
    );
    // First line: "24576, NVIDIA GeForce RTX 4090"
    const firstLine = stdout.trim().split("\n")[0];
    if (!firstLine) return null;
    const [memMib, name] = firstLine.split(",").map((s) => s.trim());
    const vramMiB = parseInt(memMib, 10);
    if (!Number.isFinite(vramMiB) || vramMiB < 1024) return null;
    return {
      vendor: "nvidia",
      name: name || "Unknown NVIDIA GPU",
      vramGB: Math.round((vramMiB / 1024) * 10) / 10,
    };
  } catch {
    // nvidia-smi missing, permission denied, no GPU, ROCm/Apple — all
    // collapse to "no NVIDIA GPU". The recommender handles this.
    return null;
  }
}

/**
 * Detect the host's hardware. Always resolves with a fingerprint; the
 * `gpu` field is undefined when no NVIDIA GPU was found (Apple Silicon
 * machines, AMD, Intel, headless servers, etc.).
 */
export async function detectHardware(): Promise<HardwareFingerprint> {
  const platform = process.platform;
  const arch = process.arch;
  const cpuCount = os.cpus().length;
  const ramGB = Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10;
  const appleSilicon = platform === "darwin" && arch === "arm64";
  const gpu = await detectNvidiaGpu();
  return {
    platform,
    arch,
    cpuCount,
    ramGB,
    appleSilicon,
    gpu: gpu ?? undefined,
  };
}

/**
 * Recommend three MoA configs based on the fingerprint. Conservative
 * defaults — operator can always upgrade. Backend defaults to SGLang
 * for NVIDIA GPUs (best parallel-MoA throughput via RadixAttention) and
 * Ollama for Apple Silicon + non-GPU hosts (the only backend with stable
 * Apple Silicon support and the easiest install path).
 */
export function recommendMoAConfigs(
  hw: HardwareFingerprint
): MoARecommendation[] {
  // ── NVIDIA path ──────────────────────────────────────────────────
  if (hw.gpu) {
    const vram = hw.gpu.vramGB;
    const backend = "sglang" as const;

    // 24GB+ (RTX 3090, 4090, 5090) — comfortably runs 7B-class proposers
    // with room for a 32B aggregator at Q4.
    if (vram >= 22) {
      return [
        {
          tier: "speed",
          proposerModel: "Qwen/Qwen2.5-7B-Instruct",
          aggregatorModel: "Qwen/Qwen2.5-7B-Instruct",
          quantization: "Q4_K_M",
          backend,
          expectedLatency: "~5-10s per Swarm turn",
          rationale:
            "5×7B Q4 proposers + 7B aggregator all resident on a 24GB GPU. RadixAttention shares the user-message prefix → highest tok/s.",
        },
        {
          tier: "balanced",
          proposerModel: "Qwen/Qwen2.5-7B-Instruct",
          aggregatorModel: "Qwen/Qwen2.5-14B-Instruct",
          quantization: "Q4_K_M",
          backend,
          expectedLatency: "~15-25s per Swarm turn",
          rationale:
            "7B proposers, 14B aggregator — the 14B synthesizes more carefully without busting VRAM. Best quality-per-second ratio on this tier.",
        },
        {
          tier: "quality",
          proposerModel: "Qwen/Qwen2.5-14B-Instruct",
          aggregatorModel: "Qwen/Qwen2.5-32B-Instruct",
          quantization: "Q4_K_M",
          backend,
          expectedLatency: "~30-60s per Swarm turn",
          rationale:
            "14B proposers + 32B aggregator. Approaches Claude-Haiku-tier output quality. Tight on 24GB — use --mem-fraction-static 0.90 and turn off other GPU workloads.",
        },
      ];
    }

    // 12-16GB (RTX 4060/4070/4080) — 7B comfortable, no room for 32B agg.
    if (vram >= 12) {
      return [
        {
          tier: "speed",
          proposerModel: "Qwen/Qwen2.5-7B-Instruct",
          aggregatorModel: "Qwen/Qwen2.5-7B-Instruct",
          quantization: "Q4_K_M",
          backend,
          expectedLatency: "~10-20s per Swarm turn",
          rationale: "5×7B Q4 fits comfortably in 12-16GB VRAM with prefix-cache reuse.",
        },
        {
          tier: "balanced",
          proposerModel: "Qwen/Qwen2.5-7B-Instruct",
          aggregatorModel: "Qwen/Qwen2.5-14B-Instruct",
          quantization: "Q4_K_M",
          backend,
          expectedLatency: "~25-40s per Swarm turn",
          rationale: "7B proposers + 14B aggregator — tight but feasible at 12GB+; consider 3 proposers instead of 5 if OOM.",
        },
        {
          tier: "quality",
          proposerModel: "Qwen/Qwen2.5-14B-Instruct",
          aggregatorModel: "Qwen/Qwen2.5-14B-Instruct",
          quantization: "Q4_K_M",
          backend,
          expectedLatency: "~40-70s per Swarm turn",
          rationale: "14B everywhere. 32B aggregator won't fit alongside proposers at this VRAM tier.",
        },
      ];
    }

    // 8GB and below — small models only.
    return [
      {
        tier: "speed",
        proposerModel: "Qwen/Qwen2.5-3B-Instruct",
        aggregatorModel: "Qwen/Qwen2.5-3B-Instruct",
        quantization: "Q4_K_M",
        backend,
        expectedLatency: "~10-20s per Swarm turn",
        rationale: "3B model fits 5× in 8GB VRAM at Q4. Quality is meaningfully below 7B but still useful for many tasks.",
      },
      {
        tier: "balanced",
        proposerModel: "Qwen/Qwen2.5-3B-Instruct",
        aggregatorModel: "Qwen/Qwen2.5-7B-Instruct",
        quantization: "Q4_K_M",
        backend,
        expectedLatency: "~20-40s per Swarm turn",
        rationale: "3B proposers, 7B aggregator. 7B may need --mem-fraction-static 0.80 at this VRAM.",
      },
      {
        tier: "quality",
        proposerModel: "Qwen/Qwen2.5-7B-Instruct",
        aggregatorModel: "Qwen/Qwen2.5-7B-Instruct",
        quantization: "Q4_K_M",
        backend,
        expectedLatency: "~30-60s per Swarm turn",
        rationale: "All 7B. May require reducing concurrent proposer count from 5 to 3 if OOM at runtime.",
      },
    ];
  }

  // ── Apple Silicon path ──────────────────────────────────────────
  if (hw.appleSilicon) {
    // Unified memory model: ramGB also bounds VRAM. M3 Max 64GB or M4 Max
    // can hold larger models than equivalent x86+24GB GPU.
    if (hw.ramGB >= 48) {
      return [
        {
          tier: "speed",
          proposerModel: "qwen2.5:7b",
          aggregatorModel: "qwen2.5:7b",
          quantization: "Q4_K_M",
          backend: "ollama",
          expectedLatency: "~8-15s per Swarm turn",
          rationale: "7B Q4 runs around 60-90 tok/s on M3/M4 Max via Metal. 5×7B fits comfortably.",
        },
        {
          tier: "balanced",
          proposerModel: "qwen2.5:14b",
          aggregatorModel: "qwen2.5:14b",
          quantization: "Q4_K_M",
          backend: "ollama",
          expectedLatency: "~20-40s per Swarm turn",
          rationale: "14B is the unified-memory sweet spot on 48GB+ Apple Silicon — fits comfortably without thrashing.",
        },
        {
          tier: "quality",
          proposerModel: "qwen2.5:14b",
          aggregatorModel: "qwen2.5:32b",
          quantization: "Q4_K_M",
          backend: "ollama",
          expectedLatency: "~40-80s per Swarm turn",
          rationale: "14B proposers + 32B aggregator. The 32B at Q4 needs ~20GB unified memory. Best output quality on this hardware.",
        },
      ];
    }
    if (hw.ramGB >= 24) {
      return [
        {
          tier: "speed",
          proposerModel: "qwen2.5:7b",
          aggregatorModel: "qwen2.5:7b",
          quantization: "Q4_K_M",
          backend: "ollama",
          expectedLatency: "~10-20s per Swarm turn",
          rationale: "7B fits 5× on 24GB unified memory.",
        },
        {
          tier: "balanced",
          proposerModel: "qwen2.5:7b",
          aggregatorModel: "qwen2.5:14b",
          quantization: "Q4_K_M",
          backend: "ollama",
          expectedLatency: "~25-45s per Swarm turn",
          rationale: "Mix 7B and 14B. Memory pressure is fine on 24GB.",
        },
        {
          tier: "quality",
          proposerModel: "qwen2.5:14b",
          aggregatorModel: "qwen2.5:14b",
          quantization: "Q4_K_M",
          backend: "ollama",
          expectedLatency: "~50-90s per Swarm turn",
          rationale: "14B everywhere. 32B aggregator doesn't fit alongside proposers at 24GB.",
        },
      ];
    }
    // < 24GB Apple Silicon (M1/M2 8-16GB)
    return [
      {
        tier: "speed",
        proposerModel: "qwen2.5:3b",
        aggregatorModel: "qwen2.5:3b",
        quantization: "Q4_K_M",
        backend: "ollama",
        expectedLatency: "~10-20s per Swarm turn",
        rationale: "3B Q4 is the only practical option below 16GB unified memory for a 5-proposer fan-out.",
      },
      {
        tier: "balanced",
        proposerModel: "qwen2.5:3b",
        aggregatorModel: "qwen2.5:7b",
        quantization: "Q4_K_M",
        backend: "ollama",
        expectedLatency: "~20-40s per Swarm turn",
        rationale: "3B proposers, 7B aggregator. May need to drop proposers from 5 to 3 on tight memory.",
      },
      {
        tier: "quality",
        proposerModel: "qwen2.5:7b",
        aggregatorModel: "qwen2.5:7b",
        quantization: "Q4_K_M",
        backend: "ollama",
        expectedLatency: "~40-80s per Swarm turn",
        rationale: "7B everywhere. Tight on memory at 16GB — consider closing other apps.",
      },
    ];
  }

  // ── x86 without NVIDIA GPU (CPU-only or AMD/Intel) ──────────────
  // We don't recommend running MoA workloads on CPU — latency is brutal
  // (>2 min per Swarm turn even on small models). Suggest cloud provider.
  return [
    {
      tier: "speed",
      proposerModel: "(cloud) anthropic/claude-haiku-4-5",
      aggregatorModel: "(cloud) anthropic/claude-haiku-4-5",
      quantization: "n/a",
      backend: "sglang",
      expectedLatency: "~5-10s per Swarm turn (cloud)",
      rationale: "No NVIDIA GPU detected. CPU-only MoA is impractical (>2 min/turn). Cloud Claude Haiku via OpenRouter or direct Anthropic is the cheapest cloud option.",
    },
    {
      tier: "balanced",
      proposerModel: "(cloud) anthropic/claude-sonnet-4-6",
      aggregatorModel: "(cloud) anthropic/claude-sonnet-4-6",
      quantization: "n/a",
      backend: "sglang",
      expectedLatency: "~10-15s per Swarm turn (cloud)",
      rationale: "Cloud Sonnet for quality. If you have a GPU and Orchestra didn't detect it, check nvidia-smi is in PATH.",
    },
    {
      tier: "quality",
      proposerModel: "(cloud) anthropic/claude-sonnet-4-6",
      aggregatorModel: "(cloud) anthropic/claude-opus-4-7",
      quantization: "n/a",
      backend: "sglang",
      expectedLatency: "~15-30s per Swarm turn (cloud)",
      rationale: "Sonnet proposers + Opus aggregator. Expensive but the strongest result; consider before going local-only.",
    },
  ];
}

/** Render a multi-line operator-facing summary suitable for the boot log. */
export function formatHardwareReport(report: HardwareReport): string {
  const { fingerprint: hw, recommendations } = report;
  const lines: string[] = [];

  const hwLine = hw.gpu
    ? `${hw.gpu.name} ${hw.gpu.vramGB}GB · ${hw.ramGB}GB RAM · ${hw.cpuCount} cores · ${hw.platform}/${hw.arch}`
    : hw.appleSilicon
      ? `Apple Silicon · ${hw.ramGB}GB unified memory · ${hw.cpuCount} cores · darwin/arm64`
      : `${hw.ramGB}GB RAM · ${hw.cpuCount} cores · ${hw.platform}/${hw.arch} · no NVIDIA GPU detected`;
  lines.push(`[Hardware] ${hwLine}`);

  lines.push(`[Hardware] Suggested MoA configs (open Settings → Models to apply):`);
  for (const r of recommendations) {
    lines.push(
      `  - ${r.tier.padEnd(8)} ${r.proposerModel} proposers / ${r.aggregatorModel} aggregator @ ${r.quantization} · ${r.backend} · ${r.expectedLatency}`
    );
  }
  return lines.join("\n");
}

/** One-shot: detect + recommend + summary in a single call. */
export async function buildHardwareReport(): Promise<HardwareReport> {
  const fingerprint = await detectHardware();
  const recommendations = recommendMoAConfigs(fingerprint);
  const summary = formatHardwareReport({ fingerprint, recommendations, summary: "" });
  return { fingerprint, recommendations, summary };
}
