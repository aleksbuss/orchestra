#!/usr/bin/env python3
"""
Paired A/B statistics for the parallelism-vs-single Skeptic-proof track.

Compares two eval result JSONs (arm A vs arm B) produced by
`scripts/run-evals.ts` — each is an EvalSuiteResult with a `.cases[]` array.
Cases are PAIRED by id (the same hard case ran in both arms), so the correct
test is McNemar's exact test on the discordant pairs, NOT a two-proportion
z-test (that assumes independent samples and inflates significance).

Usage:
  python3 scripts/eval-ab-stats.py <armA.json> <armB.json>
  # convention: armA = swarm, armB = single agent

Output: per-arm pass counts, the 2x2 discordant table, McNemar exact
two-sided p-value, and the pass-rate effect size (armA - armB).

No third-party deps (math.comb only) so it runs anywhere python3 does.
"""
import json
import random
import sys
from math import comb


def load_maps(path: str) -> tuple[dict[str, bool], dict[str, bool]]:
    """id -> (passed, delivered). `delivered` is False for an EMPTY response
    (a no-answer / delivery failure). Separating delivery from correctness is
    load-bearing: scoring an empty response as a plain FAIL conflates 'didn't
    answer' with 'answered wrong' and manufactures a false capability signal."""
    with open(path) as f:
        suite = json.load(f)
    passed: dict[str, bool] = {}
    delivered: dict[str, bool] = {}
    for c in suite.get("cases", []):
        passed[c["id"]] = bool(c.get("passed")) and not c.get("error")
        delivered[c["id"]] = len((c.get("response") or "").strip()) > 0 and not c.get("error")
    return passed, delivered


def bootstrap_delta_ci(
    paired: list[tuple[bool, bool]], iters: int = 5000, seed: int = 12345
) -> tuple[float, float]:
    """
    95% CI on the paired pass-rate difference (A - B) by resampling CASES with
    replacement. A p-value alone is not a defensible benchmark number — report an
    interval. Resampling the case (not the arm) preserves the pairing.
    """
    rng = random.Random(seed)
    n = len(paired)
    if n == 0:
        return (0.0, 0.0)
    deltas = []
    for _ in range(iters):
        sample = [paired[rng.randrange(n)] for _ in range(n)]
        a = sum(1 for ap, _ in sample if ap)
        b = sum(1 for _, bp in sample if bp)
        deltas.append((a - b) / n)
    deltas.sort()
    lo = deltas[int(0.025 * iters)]
    hi = deltas[int(0.975 * iters)]
    return (lo, hi)


def mcnemar_exact_two_sided(b: int, c: int) -> float:
    """
    Exact McNemar p-value. b, c are the two discordant counts.
    Under H0 each discordant pair is a fair coin; two-sided exact binomial.
    """
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(comb(n, i) for i in range(0, k + 1)) * (0.5 ** n)
    return min(1.0, 2.0 * tail)


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    a_path, b_path = sys.argv[1], sys.argv[2]
    a, a_deliv = load_maps(a_path)
    b, b_deliv = load_maps(b_path)

    ids = sorted(set(a) & set(b))
    only_a = set(a) - set(b)
    only_b = set(b) - set(a)
    if only_a or only_b:
        print(f"WARNING: unpaired cases ignored — only in A: {sorted(only_a)}, only in B: {sorted(only_b)}")
    if not ids:
        print("ERROR: no shared case ids between the two files.")
        return 2

    # 2x2 paired contingency.
    both_pass = both_fail = a_only = b_only = 0  # a_only = A pass & B fail
    discordant = []
    for cid in ids:
        ap, bp = a[cid], b[cid]
        if ap and bp:
            both_pass += 1
        elif not ap and not bp:
            both_fail += 1
        elif ap and not bp:
            a_only += 1
            discordant.append((cid, "A-only"))
        else:
            b_only += 1
            discordant.append((cid, "B-only"))

    n = len(ids)
    a_pass = both_pass + a_only
    b_pass = both_pass + b_only
    p = mcnemar_exact_two_sided(a_only, b_only)
    delta = (a_pass - b_pass) / n
    ci_lo, ci_hi = bootstrap_delta_ci([(a[cid], b[cid]) for cid in ids])

    # Delivery vs reasoning split — the correction that prevents reading a
    # delivery-reliability gap as a capability gap.
    a_na = sum(1 for cid in ids if not a_deliv[cid])
    b_na = sum(1 for cid in ids if not b_deliv[cid])
    a_dd = [cid for cid in ids if a_deliv[cid]]
    b_dd = [cid for cid in ids if b_deliv[cid]]
    a_dpass = sum(1 for cid in a_dd if a[cid])
    b_dpass = sum(1 for cid in b_dd if b[cid])

    print("=" * 60)
    print(f"Paired A/B — {n} shared cases")
    print(f"  Arm A (swarm) : {a_pass}/{n} passed ({a_pass / n:.1%})   [{a_path}]")
    print(f"  Arm B (single): {b_pass}/{n} passed ({b_pass / n:.1%})   [{b_path}]")
    print("-" * 60)
    print("  DELIVERY vs REASONING (an empty response = no answer, not a wrong answer):")
    print(f"    Arm A no-answer: {a_na}/{n}   delivered-only correct: {a_dpass}/{len(a_dd)}"
          + (f" ({a_dpass / len(a_dd):.0%})" if a_dd else ""))
    print(f"    Arm B no-answer: {b_na}/{n}   delivered-only correct: {b_dpass}/{len(b_dd)}"
          + (f" ({b_dpass / len(b_dd):.0%})" if b_dd else ""))
    print("    ^ The McNemar test below counts a no-answer as a FAIL (error-rate framing).")
    print("      Delivered-only is the REASONING framing — but it has SURVIVOR BIAS")
    print("      (cases that timed out are not missing-at-random), so it is not a clean")
    print("      capability comparison either. If no-answer differs a lot between arms,")
    print("      the paired Δ below is a DELIVERY signal, not a reasoning one.")
    print("-" * 60)
    print("  Contingency (paired):")
    print(f"    both pass        : {both_pass}")
    print(f"    A pass, B fail   : {a_only}   <- swarm rescues")
    print(f"    A fail, B pass   : {b_only}   <- single rescues")
    print(f"    both fail        : {both_fail}")
    print("-" * 60)
    print(f"  Effect size (A-B pass-rate): {delta:+.1%}")
    print(f"  95% CI (bootstrap, paired) : [{ci_lo:+.1%}, {ci_hi:+.1%}]")
    print(f"  McNemar exact two-sided p  : {p:.4f}")
    sig = "SIGNIFICANT (p<0.05)" if p < 0.05 else "not significant (p>=0.05)"
    print(f"  Verdict: {sig}")
    if a_only + b_only < 6:
        print(f"  NOTE: only {a_only + b_only} discordant pairs — underpowered; "
              "even a real effect can't reach p<0.05. Add cases/repeats.")
    if discordant:
        print("-" * 60)
        print("  Discordant cases:")
        for cid, which in discordant:
            print(f"    {which:7} {cid}")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
