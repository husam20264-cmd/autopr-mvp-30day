# Demo Script — 5 Minutes

## CTO Call Opening — 60 Seconds

"Hi [Name]. Quick context: every LLM call your team makes today vanishes after use. Same bug next sprint, same $0.03 call. We built a layer that captures every PR outcome, verifies it against merge/close, and promotes proven patterns into reusable policies. Running on 22 real repos right now — VS Code, Next.js, TypeScript — at 93.9% merge rate and falling cost per PR. The first fix costs LLM inference. The second costs near zero. Want me to show you how?"

---



## Minute 1: The Problem (0:00–1:00)

"Every LLM call in your pipeline vanishes after use. Same bug next sprint? Same $0.03 call. No accumulation. Your LLM costs scale linearly with headcount. We fix that."

## Minute 2: The Live System (1:00–2:00)

Open terminal. Run:
```
node scripts/dashboard.js
```

Point to the numbers:
- **93.9% merge rate** — "This isn't a demo. This is running on 22 repos right now."
- **$0.03 per PR** — "Industry average is 10-50x higher because they pay per generation. We pay per verified knowledge."
- **3 active policies** — "These were auto-promoted by the system. No human wrote them."

## Minute 3: Show the Trace (2:00–3:00)

Run:
```
node scripts/lifecycle_trace.js
```

Scroll to a policy entry:
"Every decision has a causal chain. Not 'AI said so.' But: event → classifier → confidence → safety check → trust score → verifier → outcome → truth → policy. Full audit trail. Every step logged."

## Minute 4: Explain the Economics (3:00–4:00)

"This is the one-liner: The first PR costs $0.03 LLM inference. It gets verified against merge/close. If correct, the pattern is stored. The second time the same bug appears on any of your 200 repos — the system handles it from memory at near-zero cost."

"Your cost curve: linear with team size. Our cost curve: flattens with knowledge accumulation."

## Minute 5: Close (4:00–5:00)

"You can keep paying per generation. Or you can let every PR feed a compounding knowledge asset. 15-min technical deep-dive next week?"

---

## One-Slide Summary (for presentation decks)

| Before (LLM-only) | After (AutoPR) |
|---|---|
| Per-call cost: $0.03 | Per-call cost: $0.001 (cached) |
| Knowledge: vanishes | Knowledge: accumulates |
| Audit trail: none | Audit trail: causal chain |
| Cost curve: linear with headcount | Cost curve: flattens with reuse |
| Accuracy: static | Accuracy: improves per cycle (86.3%) |
