import { describe, it, expect } from "vitest";
import type { AppSettings } from "@/lib/types";
import {
  DEFAULT_DEGRADATION_POLICY,
  allowsModelSubstitution,
  isDegradationPolicy,
  resolveDegradationPolicy,
  undeliverableNotice,
} from "./degradation-policy";

const s = (policy?: unknown) =>
  ({ degradationPolicy: policy } as unknown as Pick<AppSettings, "degradationPolicy">);

describe("isDegradationPolicy", () => {
  it("accepts exactly the three policies", () => {
    expect(isDegradationPolicy("speed")).toBe(true);
    expect(isDegradationPolicy("quality")).toBe(true);
    expect(isDegradationPolicy("ask")).toBe(true);
  });

  it("rejects anything else (the wire boundary must not trust the client)", () => {
    expect(isDegradationPolicy("SPEED")).toBe(false);
    expect(isDegradationPolicy("")).toBe(false);
    expect(isDegradationPolicy(undefined)).toBe(false);
    expect(isDegradationPolicy(null)).toBe(false);
    expect(isDegradationPolicy(1)).toBe(false);
    expect(isDegradationPolicy({ policy: "speed" })).toBe(false);
  });
});

describe("resolveDegradationPolicy", () => {
  it("defaults to speed with nothing configured", () => {
    expect(resolveDegradationPolicy(undefined)).toBe("speed");
    expect(DEFAULT_DEGRADATION_POLICY).toBe("speed");
  });

  it("reads the settings default", () => {
    expect(resolveDegradationPolicy(s("quality"))).toBe("quality");
  });

  it("a per-request override beats settings", () => {
    expect(resolveDegradationPolicy(s("quality"), "speed")).toBe("speed");
    expect(resolveDegradationPolicy(s("speed"), "ask")).toBe("ask");
  });

  it("BACKGROUND runs are always speed — nobody is there to read a notice", () => {
    expect(resolveDegradationPolicy(s("quality"), "ask", { background: true })).toBe("speed");
    expect(resolveDegradationPolicy(s("ask"), undefined, { background: true })).toBe("speed");
  });

  it("falls back rather than throwing on garbage (a bad policy must never fail a turn)", () => {
    expect(resolveDegradationPolicy(s("nonsense"))).toBe("speed");
    expect(resolveDegradationPolicy(s("quality"), "nonsense")).toBe("quality");
    expect(resolveDegradationPolicy(s(42), { policy: "ask" })).toBe("speed");
  });
});

describe("allowsModelSubstitution", () => {
  it("only speed may swap in a different model", () => {
    expect(allowsModelSubstitution("speed")).toBe(true);
    expect(allowsModelSubstitution("quality")).toBe(false);
    expect(allowsModelSubstitution("ask")).toBe(false);
  });
});

describe("undeliverableNotice", () => {
  it("quality explains that substitution was deliberately withheld", () => {
    const n = undeliverableNotice("quality", "openrouter/brain:free", true);
    expect(n).toContain("openrouter/brain:free");
    expect(n).toMatch(/quality mode/i);
    expect(n).toMatch(/Continue/);
  });

  it("ask offers the choice, naming the setting that changes it", () => {
    const n = undeliverableNotice("ask", "openrouter/brain:free", true);
    expect(n).toMatch(/speed/);
    expect(n).toMatch(/Continue/);
  });

  it("with no substitute available every policy gets the same honest message", () => {
    const a = undeliverableNotice("speed", "x/y", false);
    const b = undeliverableNotice("quality", "x/y", false);
    const c = undeliverableNotice("ask", "x/y", false);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toMatch(/empty response/i);
  });

  it("speed never claims a substitution was withheld (it does not withhold any)", () => {
    expect(undeliverableNotice("speed", "x/y", true)).not.toMatch(/quality mode/i);
  });
});
