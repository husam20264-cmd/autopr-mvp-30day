# v1 → Outreach-Ready Exit Criteria

## Definition

v1 is considered outreach-ready when the system demonstrates
**stable, repeatable learning signals across multiple repos and time windows**
— not single-run artifacts.

---

## 1. Truth Layer Stability (non-negotiable)

| Criterion | Threshold |
|-----------|-----------|
| Truth events | ≥ 150 |
| Distinct repositories | ≥ 5 |
| Time windows | ≥ 2 separate runs/days |
| Merge rate variance | ≤ ±10% across runs |
| Single-repo dominance | No repo > 40% of total truth events |

---

## 2. Learning Signal Stability

| Criterion | Threshold |
|-----------|-----------|
| Pattern applications | ≥ 100 total |
| Reuse rate | ≥ 30% of PRs use existing patterns |
| Cross-repo patterns | ≥ 3 patterns reused across ≥ 3 repos each |

---

## 3. LLM Dependency Reduction (North Star)

| Criterion | Threshold |
|-----------|-----------|
| LLM calls/PR trend | ↓ downward across runs (not flat noise) |
| Knowledge reuse rate | ≥ 25% sustained |

---

## 4. Calibration Validity

| Criterion | Threshold |
|-----------|-----------|
| Calibration updates | ≥ 10 |
| Threshold movement | values change over time, not static |
| Policy re-adjustments | ≥ 1 policy adjusted twice from new truth data |

---

## 5. Policy Layer Maturity

| Criterion | Threshold |
|-----------|-----------|
| Active policies | ≥ 3 |
| Multi-repo policies | ≥ 1 policy derived from ≥ 2 independent repos |
| Sample floor | No policy based on < 10 samples |

---

## 6. Failure Diversity

| Criterion | Threshold |
|-----------|-----------|
| Fix types | dependency, lint, trivial_bug all present |
| Failure modes | ≥ 2 failure modes per fix type (merged + closed PRs) |

---

## 7. Temporal Signal

| Criterion | Threshold |
|-----------|-----------|
| Collection window | ≥ 7 days OR ≥ 5 separate runs |

Prevents single-run illusion stability.

---

## Hard Disqualifiers

Do **not** launch if any of:

- Policies exist but only from one repo cluster
- Memory hit rate ≈ 0
- Reuse rate has high variance (unstable)
- Truth events < 100
- LLM dominates > 80% of all PR paths

---

## Decision Rule

```
READY  = all criteria true → outreach allowed
NOT READY = any criterion false → continue pilot
```
