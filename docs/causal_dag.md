# Structural Causal Model for AutoPR

## Problem

Current causality tests treat ESR, calibration, and distribution as
causally related variables. They are not. All three are **projections**
of a latent system state S_t, modulated by interventions I_t.

Without modeling the intervention explicitly, any pairwise test
(ESR → Cal, Cal → ESR, Dist → ESR) is measuring correlation,
not causation.

## Causal Graph (DAG)

```
I_t (intervention)
 │
 │  ┌──────────────────────────┐
 │  │                          │
 ▼  ▼                          │
S_t ──► S_{t+1}                │
 │        │                     │
 ├──► ESR_t                    │
 ├──► Cal_t                    │
 ├──► Dist_t                   │
 └──► Merge_t                  │
                               │
         I_t influences S_t    │
         S_t projects to obs   │
         S_{t+1} depends on    │
           S_t + I_t           │
                               │
         ←── time ─────────────┘
```

**Edges:**
- `I_t → S_t`: intervention (chaos type) shifts system state
- `I_t → S_{t+1}`: intervention has lagged effect
- `S_t → ESR_t`: state projects to ESR score
- `S_t → Cal_t`: state projects to calibration thresholds
- `S_t → Dist_t`: state projects to fix-type distribution
- `S_t → Merge_t`: state projects to merge rate
- No direct edges between ESR, Cal, Dist, Merge at same t

## The Confounding Problem

Any observed correlation between ESR_t and Cal_t is:

```
ESR_t ← S_t → Cal_t
```

This is a classic **confounding** structure. S_t (latent system state)
is the common cause. Regressing ESR on Cal is a **spurious regression**
— the correlation exists because both are driven by the same latent
process, not because one causes the other.

## What Granger Actually Tests

Granger: "Does ESR_{t-1} improve prediction of Cal_t beyond Cal_{t-1}?"

In this DAG, if S_t is the true driver:

```
ESR_{t-1} ← S_{t-1} → S_t → Cal_t
```

ESR_{t-1} appears to "predict" Cal_t because both are caused by
S_{t-1} and S_t. This is **Granger causality without structural
causality** — the direction is an artifact of the lag structure,
not evidence that ESR drives calibration.

## What Would Actually Be Causal Evidence

True causality requires an **intervention** on one variable while
holding the latent state fixed. In this system, the only way
to get causal evidence is to vary `I_t` (intervention type) and
observe the downstream effect on S_t+1.

## Intervention Tagging

Each run must record:

| Field | Example | Purpose |
|-------|---------|---------|
| `intervention_type` | `chaos_high`, `chaos_low`, `targeted_dependency` | What was injected |
| `intervention_strength` | 0.35, 0.05, 0.15 | CHAOS_RATE used |
| `target_fix_type` | `dependency`, `all`, `none` | Which fix type was stressed |
| `run_id` | 1, 2, 3, ... | Sequential identifier |
| `regime` | `noise`, `emerging`, `stable` | Inferred after run |

With this, we can ask proper causal questions:

- Does high chaos cause merge rate to drop? (I_t → Merge_{t+1})
- Does targeted dependency injection cause calibration divergence?
  (I_t with target=dependency → Cal_{t+1})
- Does removing chaos cause ESR to revert?
  (I_t with strength=0.05 → ESR_{t+1})

## What the Existing Tests Actually Measure

| Test | Measures | In DAG terms |
|------|----------|-------------|
| `causal_test` (static R²) | `Corr(ESR_t, Cal_t)` | `S_t → ESR_t` and `S_t → Cal_t` → spurious |
| `granger_test` (lagged) | `ESR_{t-1} → Cal_t \| Cal_{t-1}` | `S_{t-1} → S_t` artifact |
| `separation_test` (distribution) | `ESR_t ⊥ Dist_t \| S_t` | residual after conditioning on partial observation |

## When Do These Tests Become Meaningful?

Only when `I_t` (intervention) is explicitly conditioned on:

```
Granger(ESR → Cal | I_{t-1}, I_t)
```

This removes the confounding effect of the intervention and reveals
whether ESR has genuine predictive power over Cal.

Without `I_t` in the model, all three tests are **structurally
confounded** and will remain NULL regardless of n.

## Next Steps

1. Add `intervention_type` to each ESR history entry in esr_score.js
2. Update `causal_granger_test.js` to condition on I_t
3. The DAG above becomes testable rather than philosophical

Until interventions are tagged, the system has a measurement stack —
but not a causal stack.
