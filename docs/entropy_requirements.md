# Minimum Entropy Requirements per Layer

## Principle

Every layer in the observability stack requires a minimum amount of
**structural diversity** in its input stream before its output is
non-spurious. Below those thresholds, the layer is a deterministic
function of noise, not a statistical estimator.

---

## Layer 1: Data Generation (`run_real_pilot.js`)

| Dimension | Minimum | Why |
|-----------|---------|-----|
| Truth events | ≥ 150 | Hard block in exit criteria. Below 100 → any phase label is random. |
| Fix types | ≥ 3 (trivial_bug, lint, dependency) | Below 3 → single-mode lock prevents any generalization signal. |
| Repos | ≥ 10 | Below 10 → per-repo calibration is memorization, not adaptation. |
| Outcomes | both merged + closed | Without closed PRs, acceptance rate is a constant (100%) — no useful variance. |
| Fix-type entropy (Simpson) | ≥ 0.3 | H = 1 - Σ(pᵢ²). Current: 1 - (0.978² + 0.022²) = 0.043. Need 7× more. |

**Entropy threshold:** `count(DISTINCT fix_type WITH pct >= 5%) >= 3`

---

## Layer 2: Decision Gate (`check_exit_criteria.js`)

| Criterion | Minimum entropy | Spurious if |
|-----------|----------------|-------------|
| Truth events ≥ 150 | n/a (count) | n < 100 |
| Distinct repos ≥ 5 | repos ≥ 5 | Single-repo dominance > 40% |
| Fix types ≥ 3 | ≥ 2 types at ≥ 5% each | All events from one fix type |
| Merge rate variance ≤ ±10% | ≥ 2 independent runs | Single-run snapshot |
| Temporal ≥ 5 days | ≥ 5 separate windows | Single-day spike |

**Gate is valid only when:** all hard disqualifiers pass AND
at least 3 criteria have non-trivial entropy (not default values).

Current status: **Gate is structurally correct but always returns NOT READY**
because the entropy floor (150 events) has not been crossed.

---

## Layer 3: Scalar Estimator (`esr_score.js`)

| Sub-signal | Minimum n | Minimum entropy | Spurious if |
|------------|-----------|----------------|-------------|
| fix_type_entropy | ≥ 50 events | H ≥ 0.3 | Only one fix type exists |
| pattern_dominance_shift | ≥ 100 pattern apps | Top pattern < 80% | Single pattern > 90% |
| calibration_divergence | ≥ 10 samples per threshold | Range ≥ 0.1 | All thresholds near-identical |
| merge_regime_change | ≥ 5 runs | Rates outside [90%,100%] | Every run in same band |
| policy_competition | ≥ 5 active policies | ≥ 2 share a domain | One policy per domain |
| reuse_stabilization | requires fix_type_entropy ≥ 0.3 first | — | Premature before 2nd type |

**ESR score is non-spurious when:** ≥ 4 of 6 sub-signals have met their
entropy minimums.

Current status: **ESR = 0.169 but 5/6 sub-signals are entropy-starved.**
The score reflects partial pattern shift, but this is fragile —
one more run of identical data could collapse it back.

---

## Layer 4: State Interpreter (`esr_phase.js`)

| Measurement | Minimum n | Minimum SNR | Spurious if |
|-------------|-----------|-------------|-------------|
| Phase label | n ≥ 5 | — | n < 5 (any label = discretization noise) |
| Slope direction | n ≥ 7 | SNR ≥ 1.5 | n < 7 (slope dominated by endpoints) |
| R² | n ≥ 8 | — | n < 8 (R² is a function of n, not fit) |
| Confidence | n ≥ 10 | SNR ≥ 2.0 | Composite — unreliable until both n and SNR pass |
| Next transition point | n ≥ 10 | R² ≥ 0.3 | Prediction is extrapolation of noise |

**Phase label is valid when:** n ≥ 5 AND the label has been stable for
≥ 3 consecutive runs.

Current status: **Phase = ESR-2 is correct by definition of the bin**
(0.169 ∈ [0.1, 0.3)) but has no statistical validity until n ≥ 5.

---

## Layer 5: Stability Diagnostic (`stability_diagnostic.js`)

This layer is self-referential — it measures the validity of the layers
above. Its own validity is purely a function of n:

| Output | Valid when |
|--------|-----------|
| "noise dominated" | Always valid (correct by construction) |
| "weak structure" | n ≥ 5 |
| "interpretable" | n ≥ 10 |
| SNR | SNR is itself noisy until n ≥ 8 |
| Slope convergence | Requires ≥ 5 slope estimates (n ≥ 7) |

**Self-consistency condition:** The diagnostic is correct if it
self-reports "noise dominated" or "weak structure" at current n.
If it ever reports "stable signal regime" at n < 10,
the diagnostic itself is unreliable.

Current status: **Self-consistent — correctly says "noise dominated" at n=3.**

---

## Summary: Where Each Layer Stands

| Layer | Current n | Entropy threshold | Status |
|-------|-----------|-------------------|--------|
| Data gen | 45 events, 1 real fix type | 150 events, 3 types | ❌ starved |
| Decision gate | NOT READY (correct) | 150 events | ✅ always correct |
| ESR score | 0.169 (5/6 starved) | 4/6 sub-signals met | ⚠️ fragile |
| Phase label | ESR-2 (n=3) | n ≥ 5 | ❌ premature |
| Stability diag | "noise dominated" | n ≥ 5 | ✅ self-consistent |

## Decision Rule

> Do not interpret any layer above Data Generation until
> `stability_diagnostic.js` self-reports "weak structure" (n ≥ 5).

Do not trust phase transitions or slope until it self-reports
"interpretable" (n ≥ 10).

This document is a guardrail — not a code change.
Run `run_real_pilot.js` 3 more times, then re-check.
