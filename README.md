# AutoPR — Closed-Loop Learning for LLM-Generated Code

**Experimental research system.** Not a product. An open baseline for measuring how LLM-generated code improves when outcomes (merge/close) feed back into the generator.

## The Question

Every LLM call in a CI pipeline vanishes after use. Same bug next sprint, same inference cost. No accumulation across repos, teams, or time.

What happens when you close that loop?

## The Hypothesis

If every PR outcome is captured, reconciled against real merge/close events, and used to calibrate confidence, then:

1. Reusable fix patterns should emerge organically
2. Cost per repeated fix should approach zero
3. Policy accuracy should improve with truth event accumulation

**LLM → Candidate → Truth → Policy → Reuse**

## Current Experimental Data (v1 Baseline)

Small sample — not stable, not statistically significant. Shared for reproducibility.

| Metric | Value | Note |
|--------|-------|------|
| Truth events | 33 | n < 100; trends are directional, not conclusive |
| Merge rate | ~93.9% | from 33 events; expect variance as n grows |
| Overall accuracy | ~86.3% | per-repo variance significant |
| Pattern acceptance rate | ~95.2% | dominated by `trivial_bug` class |
| Active policies | 3 | promoted at 100% confidence from training data |
| Knowledge graph | 49 nodes, 74 edges | early structure; no generalization claim yet |
| LLM cost per PR | ~$0.03 | drops with pattern reuse |
| Repos scanned | 22 | VS Code, Next.js, TypeScript, Playwright, Kafka, etc. |

**Caveat:** These are early signals from a pilot on 22 repos. Not production claims. Metrics shift as dataset grows. See `config/metrics_contract.json` for the immutable measurement specification.

## Architecture

```
Event → Classifier → Memory Lookup → LLM (if miss) → Safety → Trust → Verifier → PR
                                                                                        ↓
                                                                                   Truth Event
                                                                                        ↓
                                                                              Calibrator + Promoter
                                                                                        ↓
                                                                                   Policy Store
```

Every decision traced end-to-end: event → classifier → memory → LLM (or cache) → safety → trust → verifier → PR → merge/close → truth → calibration → policy.

## Quick Start

```bash
# Install
npm install

# Configure
cp .env.example .env
# Set GITHUB_TOKEN, LLM_API_KEY (or use mock diff generator)

# Run discovery + pipeline
export NODE_ENV=test
node scripts/run_real_pilot.js

# View dashboard
node scripts/dashboard.js

# View knowledge lifecycle
node scripts/lifecycle_trace.js
```

## Project Structure

```
api/          — Express webhook server + REST API
services/     — Core: classifier, memory, LLM, safety, trust, verifier, truth, metacognition
workers/      — Background processors (pipeline, scorer)
scripts/      — CLI: dashboard, lifecycle trace, knowledge trace, pilot, truth injection
data/         — SQLite, schema, metrics contract
config/       — App config + metrics_contract.json (immutable v1 spec)
docs/         — Sales package: landing page, pitch, outreach, demo script, objections, one-pager
```

## Design Properties

- **Event-sourced metrics:** All numbers come from `decision_logs` only. No secondary counters. Prevents metric divergence.
- **Truth-gated policies:** Patterns promoted only after merge/close verification. Auto-deactivate if accuracy drops below 60%.
- **Causal audit trail:** Every PR links back to every decision stage. Not "AI said so" — full trace.
- **Experimental by design:** v1 is a reference baseline. Any v2 change must reference `config/metrics_contract.json` and be measured against v1.

## Status

- Baseline frozen, truth gap closed, 3 policies auto-promoted
- Calibration adjusts 8 thresholds dynamically
- 14 services, 20 tables, 5 run scripts
- Full sales package built (not yet deployed)

**Next:** collect 100–300 truth events; stabilize curves; then frame as product.

## License

Apache 2.0. Enterprise features (SSO, RBAC, compliance reports, advanced automation) under commercial license.

---

*"The first PR costs $0.03. The hundredth costs $0.001. Because the system learned."*
