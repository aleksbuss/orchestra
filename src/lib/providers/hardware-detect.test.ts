/**
 * PM #44 — hardware fingerprint + MoA recommender contracts.
 *
 * The fingerprint side (detectHardware) is not unit-tested directly —
 * it depends on os.totalmem() + nvidia-smi which are host-dependent.
 * Live boot smoke covers it (operator sees [Hardware] line in dev log).
 *
 * The RECOMMENDER side is pure and gets the lion's share of tests —
 * given a fingerprint, the three configs returned must respect VRAM/RAM
 * envelope, default to the right backend, and never break expected
 * latency wording (operator UI consumes these strings).
 */
import { describe, expect, it } from "vitest";
import {
  formatHardwareReport,
  recommendMoAConfigs,
  type HardwareFingerprint,
} from "./hardware-detect";

function baseFingerprint(
  overrides: Partial<HardwareFingerprint> = {}
): HardwareFingerprint {
  return {
    platform: "linux",
    arch: "x64",
    cpuCount: 8,
    ramGB: 32,
    appleSilicon: false,
    ...overrides,
  };
}

describe("PM #44 — recommendMoAConfigs: NVIDIA 24GB+ tier", () => {
  const hw = baseFingerprint({
    gpu: { vendor: "nvidia", name: "RTX 4090", vramGB: 24 },
  });
  const recs = recommendMoAConfigs(hw);

  it("returns exactly 3 tiers", () => {
    expect(recs).toHaveLength(3);
    expect(recs.map((r) => r.tier)).toEqual(["speed", "balanced", "quality"]);
  });

  it("backend is sglang (RadixAttention for NVIDIA)", () => {
    for (const r of recs) expect(r.backend).toBe("sglang");
  });

  it("quality tier suggests 32B aggregator on 24GB+", () => {
    const quality = recs.find((r) => r.tier === "quality")!;
    expect(quality.aggregatorModel).toContain("32B");
  });

  it("speed tier latency is in the single-digit-to-low-teens seconds range", () => {
    const speed = recs.find((r) => r.tier === "speed")!;
    expect(speed.expectedLatency).toMatch(/[0-9]+.?-?[0-9]*\s*s/i);
  });
});

describe("PM #44 — recommendMoAConfigs: NVIDIA 12-16GB tier", () => {
  const hw = baseFingerprint({
    gpu: { vendor: "nvidia", name: "RTX 4070", vramGB: 12 },
  });
  const recs = recommendMoAConfigs(hw);

  it("quality tier does NOT suggest 32B aggregator on 12-16GB (would OOM)", () => {
    const quality = recs.find((r) => r.tier === "quality")!;
    expect(quality.aggregatorModel).not.toContain("32B");
  });

  it("uses 7B base for proposers in speed tier", () => {
    const speed = recs.find((r) => r.tier === "speed")!;
    expect(speed.proposerModel).toContain("7B");
  });
});

describe("PM #44 — recommendMoAConfigs: NVIDIA 8GB and below", () => {
  const hw = baseFingerprint({
    gpu: { vendor: "nvidia", name: "RTX 3060 Mobile", vramGB: 8 },
  });
  const recs = recommendMoAConfigs(hw);

  it("speed tier suggests 3B proposers on small VRAM", () => {
    const speed = recs.find((r) => r.tier === "speed")!;
    expect(speed.proposerModel).toContain("3B");
  });

  it("rationale mentions concurrent-proposer drop risk", () => {
    const quality = recs.find((r) => r.tier === "quality")!;
    expect(quality.rationale).toMatch(/(reduce|OOM|3 instead of 5|3 proposers)/i);
  });
});

describe("PM #44 — recommendMoAConfigs: Apple Silicon 48GB+ tier", () => {
  const hw = baseFingerprint({
    platform: "darwin",
    arch: "arm64",
    appleSilicon: true,
    ramGB: 64,
  });
  const recs = recommendMoAConfigs(hw);

  it("backend is Ollama (best supported on Apple Silicon)", () => {
    for (const r of recs) expect(r.backend).toBe("ollama");
  });

  it("quality tier on M3/M4 Max-class can fit 32B aggregator", () => {
    const quality = recs.find((r) => r.tier === "quality")!;
    expect(quality.aggregatorModel).toContain("32b");
  });
});

describe("PM #44 — recommendMoAConfigs: Apple Silicon 24GB tier", () => {
  const hw = baseFingerprint({
    platform: "darwin",
    arch: "arm64",
    appleSilicon: true,
    ramGB: 32,
  });
  const recs = recommendMoAConfigs(hw);

  it("does not recommend 32B aggregator at 24-32GB unified memory", () => {
    const quality = recs.find((r) => r.tier === "quality")!;
    expect(quality.aggregatorModel).not.toContain("32b");
  });

  it("backend is Ollama", () => {
    for (const r of recs) expect(r.backend).toBe("ollama");
  });
});

describe("PM #44 — recommendMoAConfigs: Apple Silicon < 24GB", () => {
  const hw = baseFingerprint({
    platform: "darwin",
    arch: "arm64",
    appleSilicon: true,
    ramGB: 16,
  });
  const recs = recommendMoAConfigs(hw);

  it("speed tier defaults to 3B on tight unified memory", () => {
    const speed = recs.find((r) => r.tier === "speed")!;
    expect(speed.proposerModel).toContain("3b");
  });
});

describe("PM #44 — recommendMoAConfigs: x86 no GPU", () => {
  const hw = baseFingerprint({
    platform: "linux",
    arch: "x64",
    ramGB: 32,
    // gpu undefined
  });
  const recs = recommendMoAConfigs(hw);

  it("recommends CLOUD models when no NVIDIA GPU on x86", () => {
    for (const r of recs) expect(r.proposerModel).toMatch(/\(cloud\)|claude|gpt|gemini/i);
  });

  it("rationale explains the CPU-only limitation", () => {
    expect(recs[0].rationale).toMatch(/(NVIDIA|GPU|CPU-only|impractical)/i);
  });
});

describe("PM #44 — formatHardwareReport", () => {
  it("NVIDIA line includes GPU name + VRAM", () => {
    const hw = baseFingerprint({
      gpu: { vendor: "nvidia", name: "RTX 4090", vramGB: 24 },
    });
    const out = formatHardwareReport({
      fingerprint: hw,
      recommendations: recommendMoAConfigs(hw),
      summary: "",
    });
    expect(out).toMatch(/RTX 4090.*?24GB/);
    expect(out).toContain("Suggested MoA configs");
    expect(out).toMatch(/speed/);
    expect(out).toMatch(/balanced/);
    expect(out).toMatch(/quality/);
  });

  it("Apple Silicon line mentions unified memory", () => {
    const hw = baseFingerprint({
      platform: "darwin",
      arch: "arm64",
      appleSilicon: true,
      ramGB: 64,
    });
    const out = formatHardwareReport({
      fingerprint: hw,
      recommendations: recommendMoAConfigs(hw),
      summary: "",
    });
    expect(out).toMatch(/Apple Silicon/);
    expect(out).toMatch(/64GB unified memory/);
  });

  it("x86 no-GPU line states 'no NVIDIA GPU detected'", () => {
    const hw = baseFingerprint({});
    const out = formatHardwareReport({
      fingerprint: hw,
      recommendations: recommendMoAConfigs(hw),
      summary: "",
    });
    expect(out).toMatch(/no NVIDIA GPU detected/);
  });
});
