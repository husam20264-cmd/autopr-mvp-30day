# First True Learning Signal — Detection Checklist

## Definition

The system exits **Early Stable Regime (ESR-1)** and enters
**multi-regime learning** when any of these signals appear.

---

## 1. Fix-Type Entropy Increase

**Current state:** trivial_bug = 97.7%, lint = 2.3%, others = 0

**Detection:** A second fix type crosses ≥ 10% of total truth events.

```sql
SELECT fix_type, ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM truth_events), 1) AS pct
FROM truth_events GROUP BY fix_type ORDER BY pct DESC;
```

**Signal:** `COUNT(DISTINCT fix_type WHERE pct >= 10) >= 2`

**What it means:** The system is generalizing beyond its initial mode. Not just
"more data" — new behavioral regime.

---

## 2. Pattern Dominance Shift

**Current state:** single pattern (hash `3dd0cc04da370760`) drives most reuse.

**Detection:** A second pattern reaches ≥ 20% of total pattern applications.

```sql
SELECT pattern_hash, fix_type, times_used,
       ROUND(100.0 * times_used / (SELECT COALESCE(SUM(times_used),0) FROM patterns), 1) AS pct
FROM patterns WHERE times_used > 0 ORDER BY times_used DESC;
```

**Signal:** `SUM(patterns WHERE pct >= 20) >= 2`

**What it means:** The knowledge layer has learned a second distinct,
independently reusable behavior. The system is no longer a single-trick learner.

---

## 3. Calibration Divergence (the most important signal)

**Current state:** all per-repo thresholds cluster within [0.71, 1.0]

**Detection:** Two thresholds diverge by > 0.3 AND both have ≥ 10 samples.

```sql
SELECT metric, current_value, sample_size FROM truth_calibration
WHERE metric NOT LIKE 'baseline:%'
  AND sample_size >= 10
ORDER BY current_value ASC;
```

**Signal:** `MAX(current_value) - MIN(current_value) > 0.3`

**What it means:** The system now treats repos differently based on evidence,
not default. True localized learning — not global smoothing.

---

## 4. Merge Rate Regime Change

**Current state:** band [92.6% – 94.9%] — stationary.

**Detection:** Merge rate moves outside [90%, 100%] for two consecutive snapshots.

```sql
-- Check via baseline history snapshots
SELECT json_extract(value, '$.merge_rate') AS rate,
       json_extract(value, '$.truth_events') AS events
FROM truth_calibration, json_each(history)
WHERE metric = 'baseline:v1_snapshot';
```

**Signal:** `rate < 0.90 OR rate > 0.99` sustained across 2+ snapshots

**What it means:** A new behavior regime has appeared — either degradation
(overconfidence) or improvement (cross-pattern synergy).

---

## 5. Policy Competition

**Current state:** all policies for the same domain (trivial_bug), no conflict.

**Detection:** Two active policies apply to the same event with conflicting
confidence (> 0.2 apart).

Requires querying `decision_logs` for events where `decision` references
multiple policy IDs with different confidence values.

**Signal:** at least one event with competing policy recommendations

**What it means:** The metacognition layer is now choosing between alternatives —
the first sign of real reasoning, not pattern matching.

---

## 6. Reuse Rate Stabilization at a Second Level

**Current state:** reuse rate (pattern apps / events) = ~177%

**Detection:** Reuse rate stabilizes at a new level after a 2nd fix type
exceeds 10% of events (see #1).

**Signal:** reuse rate converges to a second band (±5%) different from the
original band

**What it means:** The system has learned a second class well enough that
its reuse behavior becomes distinguishable from the first.

---

## Decision Rule

```
ESR-1 (current)     = 0 of 6 signals detected
Transition phase    = 1–2 signals detected
Multi-regime active = 3+ signals detected
Generalization      = signals 1, 3, and 5 all present
```

## Monitoring

Run after every data collection cycle:

```bash
node scripts/check_exit_criteria.js   # outreach gate
# then manually check the 6 signals above
```

When signal 3 (calibration divergence ≥ 0.3) appears with ≥ 10 samples per
threshold — the system has its **first true learning signal**.
