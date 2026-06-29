# True vs False Emergence Map

## The Problem

When ESR score rises or phase shifts, it could mean:

**True emergence:** the system has learned a new behavioral regime
(generalization, competition, adaptation).

**False emergence:** the metric changed because the input stream
gained diversity without structural learning (more fix types,
but no new decision behavior).

This document defines how to distinguish them from the existing data
— without new code, without new instrumentation.

---

## The Two Kinds of Signal Change

| | True emergence | False emergence |
|--|----------------|-----------------|
| **Cause** | Policy competition, calibration divergence, cross-repo transfer | New fix type entering distribution, repo count increase, run-to-run noise |
| **ESR effect** | Gradual, monotonic, with decreasing variance | Step-function at the run where diversity enters, then flat |
| **Phase behavior** | Moves through phases sequentially (2→3→4) | Skips phases, oscillates, or jumps back |
| **Stability after change** | Rises, new regime stabilizes | Rises, then collapses when noise subsides |
| **Recovery if reversed** | Takes multiple runs to revert | Reverts immediately if diverse input stops |

---

## Signal 1: Fix-Type Entropy Increase (most common false positive)

When a new fix type (e.g., `dependency`) enters truth_events:

**False emergence pattern:**
- ESR rises sharply on the run where the new type appears
- Phase may jump (e.g., ESR-2 → ESR-3 in one run)
- But: `calibration_divergence` does not change — the new type
  hasn't affected any threshold yet
- Next run: ESR flattens or drops back

**True emergence pattern:**
- ESR rises gradually over 3+ runs after the new type enters
- Phase moves stepwise, not jumping
- `calibration_divergence` expands as thresholds for the new type
  diverge from existing ones
- `pattern_dominance_shift` shows the new type creating a distinct
  pattern cluster, not just being absorbed into the existing one

**Detection query:**

```sql
-- If a new fix_type appears and ESR rises but calibration divergence
-- is unchanged (< 0.01), it's false emergence.
SELECT COUNT(DISTINCT fix_type) AS types,
       (SELECT current_value FROM truth_calibration WHERE metric = 'esr_score') AS esr
FROM truth_events;
```
Cross-reference with:
```sql
SELECT MAX(current_value) - MIN(current_value) AS divergence
FROM truth_calibration
WHERE metric NOT LIKE 'baseline:%' AND sample_size >= 5;
```
If `types` increases by ≥1 while `divergence` changes by < 0.01
→ **false emergence** (diversity noise, not learning).

---

## Signal 2: Pattern Dominance Shift (most ambiguous)

When a second pattern rises past 20%:

**False emergence pattern:**
- The new pattern has high acceptance from the start (no rejection period)
- It appears suddenly, not through gradual accumulation
- Its repos are a subset of the dominant pattern's repos

**True emergence pattern:**
- The new pattern had early rejections (struggled before stabilizing)
- It appeared in repos the dominant pattern did NOT cover
- Its hash is distinct, not a variant of the dominant pattern

**Detection query:**

```sql
-- Check if the #2 pattern has any rejections
SELECT fix_type, times_accepted, times_rejected, repos
FROM patterns
WHERE times_used > 0
ORDER BY times_used DESC
LIMIT 3;
```
If the #2 pattern shows `times_rejected = 0` and its repos
are contained within the #1 pattern's repo set
→ **likely false emergence** (sub-pattern, not new learning).

---

## Signal 3: Merge Rate Regime Change

**False emergence pattern:**
- Merge rate moves outside [90%, 99%] on a single run with
  very few events (n < 10 in that run)
- Returns to band next run

**True emergence pattern:**
- Merge rate shifts and stays at the new level for 3+ runs
- Shift coincides with a new fix type or repo cluster
- Both merged AND closed events increase

**Detection:**
A one-run spike with low n in that run → false emergence.
A sustained shift across 3+ runs with n consistent → candidate for true.

---

## Signal 4: Calibration Divergence (closest to true emergence)

This is the hardest signal to fake:

**False emergence pattern:**
- Divergence increases because one repo had an unusual run
  (e.g., 1 rejection out of 7 events)
- Next run, divergence contracts back

**True emergence pattern:**
- Divergence expands monotonically across 3+ runs
- The high and low extremes are stable repos, not volatile ones
- Divergence is driven by accuracy difference, not sample-size noise

**Detection:**
Track the same two extreme thresholds across runs. If the gap
widens and the repos at the extremes do not change → true emergence.
If the extremes change identity each run → false emergence (noise).

---

## Signal 5: Policy Competition

**False emergence pattern:**
- Two policies exist for the same fix type but they never
  conflict (same decision in all cases)
- Both have near-identical confidence scores

**True emergence pattern:**
- Policies for the same fix type give different recommendations
  for different repo contexts
- Their confidences diverge when applied to the same input

**Detection:**
This requires inspecting decision_logs for events where
multiple policies were evaluated. If no such event exists,
policy competition is structural (code permits it) but not
behavioral (it never happens).

---

## Classification Procedure

For each run where ESR or phase changes:

1. **Is fix-type entropy the driver?**
   - Check if a new fix type entered this run
   - If yes → mark as `candidate_false` unless calibration divergence
     also moved

2. **Is pattern dominance the driver?**
   - Check if the #2 pattern gained ground
   - If yes and it has zero rejections → `likely_false`

3. **Is merge rate the driver?**
   - Check sample size of the deviant run
   - If n < 10 for that bucket → `likely_noise`

4. **Is calibration divergence the driver?**
   - Check extreme repos across 3 runs
   - If extremes are stable → `likely_true`

**Decision matrix:**

| Drivers | Verdict |
|---------|---------|
| Only fix-type entropy | False emergence (diversity injection) |
| Only pattern dominance (zero rejections) | False emergence (sub-pattern) |
| Only merge rate (n < 10) | Noise |
| Calibration divergence + anything | True emergence candidate |
| Pattern dominance (with rejections) + calibration | True emergence |
| 3+ signals simultaneously | System regime transition |

---

## Rule of Thumb

> If ESR rises because the system saw something new → false emergence.
> If ESR rises because the system changed how it decides → true emergence.

New input is not learning. Changed behavior is.
