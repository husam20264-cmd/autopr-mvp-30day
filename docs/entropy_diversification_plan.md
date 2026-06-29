# Minimum Entropy Diversification Plan

## Current State

Simpson H = 0.043. All 6 pipeline stages receive the same low-entropy
signal. Fixing this requires **targeted diversification per stage**,
not undifferentiated volume.

---

## Stage 1: Truth Events (raw data)

| Current | Required | How to inject |
|---------|----------|---------------|
| 45 events, 44× trivial_bug, 1× lint | ≥3 fix types with H ≥ 0.3 | Add `dependency` and `ci_failure` scenarios to pilot runner; scan repos for lock files, CI config changes |
| 8 repos, 6 dominated by same pattern | ≥10 repos with ≤40% single-repo dominance | Extend discovery to Go, Rust, or Java repos; different ecosystems yield different failure modes |
| 37 merged / 2 closed | ≥15% closed rate | Include repos with stricter CI; closed PRs generate rejection signals |
| 1 time window | ≥5 separate days | Space runs apart temporally; same-day runs inflate pseudo-replication |

**Entropy injection priority:** fix_type diversity > repo diversity >
outcome asymmetry > temporal spread.

---

## Stage 2: Patterns (knowledge layer)

| Current | Required | How to inject |
|---------|----------|---------------|
| H = 0.573 (pattern level) | H ≥ 0.7 | Requires new fix types. Current pattern entropy is artificially high because test patterns and lint patterns co-exist, but lint has only 1 truth event. |
| 10 of 12 patterns from test data | ≥80% of patterns from live repos | The current pattern distribution reflects test scaffolding, not real learning. Live patterns have 0.44 dominance; test patterns inflate the count. |
| 1 dominant hash (3dd0cc04) at 55% | Top pattern < 40% | Cross-repo trivial_bug is legitimately reusable — this needs competition from other fix types. |

**Pattern diversity is misleadingly adequate.** The H=0.573 is a mirage:
it mixes test data (which will disappear) with live data (which is
concentrated). Reality is closer to H ≈ 0.35 when test patterns are
excluded.

---

## Stage 3: Calibration (threshold layer)

| Current | Required | How to inject |
|---------|----------|---------------|
| 17 thresholds, 2 with ≥10 samples | ≥5 thresholds with ≥10 samples | Current bottleneck: per-repo thresholds have 7 samples. Another pilot run targeting the same repos gets them to 10+. |
| Range [0.714, 1.0] across thresholds | Range ≥ 0.3 | Requires divergent repo behaviors (some repos reject, some accept). Current data shows all repos trending toward acceptance. |
| Overall accuracy fixed at 0.933 | Variance across time | Overall accuracy will not move until new fix types enter distribution. |

**Calibration needs sample-size growth on existing per-repo thresholds**
to cross the interpretability floor (≥10 samples per threshold).

---

## Stage 4: ESR Score (scalar estimator)

The 6 sub-signals each need different entropy injections:

| Sub-signal | Current | Entropy needed | How |
|------------|---------|----------------|-----|
| fix_type_entropy | 0.000 | H ≥ 0.3 | New fix types (dependency, ci_failure) |
| pattern_dominance_shift | 0.446 | Top pattern < 50% | Will improve naturally with new fix types |
| calibration_divergence | 0.067 | Range ≥ 0.3 | 3+ more runs on same repos (n=7→10) |
| merge_regime_change | 0.000 | Rate outside [90%,99%] | Unlikely to change — this sub-signal may be structurally zero for this system |
| policy_competition | 0.500 | Stable ≥ 0.3 | Already above threshold, but based on only 3 policies |
| reuse_stabilization | 0.000 | H ≥ 0.3 first | Blocked until fix_type_entropy crosses 0.3 |

**ESR score will become meaningful when:** sub-signals 1 and 4 change.
The rest are already adequate or structurally constrained.

---

## Stage 5: Phase Label (state interpreter)

| Condition | Current | Needed |
|-----------|---------|--------|
| n ≥ 5 | n = 3 | 2 more runs |
| SNR ≥ 1.5 | SNR = 0 (no variance) | New fix types |
| Label stable for 3+ runs | Stable (all same value) | Spurious — stable because input is static |

**Phase label will be non-spurious when:** n ≥ 5 AND at least one
entropy injection has occurred (new fix type or repo that produced
different outcomes). Without that, label stability is a reflection
of input homogeneity, not regime convergence.

---

## Stage 6: Stability Diagnostic (meta-layer)

| Condition | Current | Needed |
|-----------|---------|--------|
| Self-reported regime | "noise dominated" | n ≥ 5 |
| SNR interpretable | SNR = 0 | Entropy injection |
| Slope convergence | 0.000 | ≥3 distinct ESR values |

**The diagnostic is currently self-consistent (correctly says
"noise dominated").** It will become useful when n ≥ 5 and
SNR > 0 — i.e., after at least one entropy-injecting run.

---

## Summary: What Each Run Should Target

| Run priority | Target | Which stage it unlocks |
|--------------|--------|----------------------|
| 1 | New fix type (dependency) | Truth events, ESR score, entropy |
| 2 | New fix type (ci_failure) | Truth events, ESR score, patterns |
| 3 | Per-repo thresholds → 10 samples | Calibration, ESR score |
| 4 | Temporal spread (different day) | Exit criteria, time windows |
| 5 | New failure mode (closed PRs) | Outcome asymmetry, merge variance |

After runs 1-2: Simpson H crosses 0.1 (exits single-mode).
After runs 3-4: ESR slope becomes interpretable.
After run 5: All 6 sub-signals have at least one non-zero input.

---

## Decision Rule

Run `node scripts/entropy_check.js` before and after each pilot run.

If the run shows:
- `Novel injection: fix-type entropy` → run was valuable
- `No measurable entropy change` → target a different repo set or
  fix type next time

Do not count statistically redundant runs toward the n required
for phase or slope validity.
