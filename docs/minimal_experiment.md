# Minimal Experiment: True Emergence vs Noise Amplification

## Hypothesis

Current signal (ESR 0.164→0.177, cal divergence 0.066, H 0.280)
is either:

- **True emergence:** system responding to structural diversity
- **Noise amplification:** chaos layer creating pseudo-signal that
  will collapse when chaos stops

## Design: 3 runs, varied chaos intensity

Run 1: **High chaos** (CHAOS_RATE = 0.35)
- Forces maximum diversity: 35% forced rejection/low-trust events
- Tests: can the system absorb stress without breaking?
- Expected if true: calibration divergence widens, ESR stabilizes
  or rises
- Expected if noise: ESR jumps erratically, divergence spikes
  then drops

Run 2: **Low chaos** (CHAOS_RATE = 0.05)
- Almost no forced variance: 95% standard probabilistic outcomes
- Tests: does the signal persist when stress is removed?
- Expected if true: ESR and divergence hold their new levels
  (not revert)
- Expected if noise: ESR drops back toward 0.169, divergence
  contracts

Run 3: **Targeted counterfactual** (CHAOS_RATE = 0.15)
- Moderate chaos but focused on one fix type (dependency)
- 50% of dependency events forced to opposite outcome of
  the previous run
- Tests: is there actual policy competition or just label noise?
- Expected if true: dependency-related thresholds diverge from
  trivial_bug thresholds
- Expected if noise: all thresholds move together (no separation)

## Decision criteria after 3 runs

| Observation | Verdict |
|-------------|---------|
| ESR reverts to ~0.169 in run 2 | Noise amplification |
| Cal divergence > 0.15 and holds | True emergence |
| ESR stays > 0.175 after run 2 | Weak emergence candidate |
| Dependency thresholds move opposite to trivial_bug | Policy competition confirmed |
| All thresholds move same direction | Distribution artifact |

## Minimal resources

- 3 × `node scripts/run_real_pilot.js` (with CHAOS_RATE edits before each)
- 3 × `node scripts/esr_score.js`
- 3 min total execution time

## Go / No-Go

If after 3 runs:
- ESR ≥ 0.175 AND cal divergence ≥ 0.10 → **true emergence candidate**
  → continue with standard chaos (CHAOS_RATE = 0.25)
- ESR < 0.170 AND divergence < 0.03 → **noise amplification confirmed**
  → redesign chaos layer or accept ESR-1 as permanent regime
- Mixed signals → repeat experiment with different fix-type targets
