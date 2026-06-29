#!/usr/bin/env node
import { getDb } from '../data/db.js';

const db = getDb();

const dim = '\x1b[2m', reset = '\x1b[0m';
const green = '\x1b[32m', yellow = '\x1b[33m', red = '\x1b[31m', cyan = '\x1b[36m', bold = '\x1b[1m';

console.log(`${bold}
╔══════════════════════════════════════════════════════════════╗
║        Knowledge Lifecycle: LLM → Truth → Promotion        ║
╚══════════════════════════════════════════════════════════════╝${reset}`);

// ── Step 1: Map each decision chain showing the LLM→Candidate→Truth path ──
const traces = db.prepare(`
  SELECT e.id AS event_id,
         dl.step, dl.decision, dl.confidence,
         dl.reasoning_chain, dl.duration_ms,
         pr.pr_number, pr.status AS pr_status,
         te.outcome, te.confidence_at_time, te.trust_score_at_time,
         te.observed_at AS truth_observed_at
  FROM events e
  JOIN decision_logs dl ON dl.event_id = e.id
  LEFT JOIN prs pr ON pr.event_id = e.id
  LEFT JOIN truth_events te ON te.event_id = e.id
  ORDER BY e.id, dl.id
`).all();

const byEvent = {};
for (const row of traces) {
  if (!byEvent[row.event_id]) byEvent[row.event_id] = [];
  byEvent[row.event_id].push(row);
}

for (const [eventId, steps] of Object.entries(byEvent)) {
  console.log(`\n${bold}━━━ Event: ${eventId}${reset}`);

  let phase = 'pipeline';
  let llmUsed = false, prCreated = false, truthRecorded = false;

  for (const s of steps) {
    if (s.decision === 'LLM_GENERATED') { phase = 'llm_generated'; llmUsed = true; }
    if (s.decision === 'PR_CREATED') prCreated = true;
    if (s.outcome) truthRecorded = true;

    const icon = s.decision === 'LLM_GENERATED' ? '🤖'
      : s.decision === 'MEMORY_HIT' ? '💾'
      : s.decision === 'MEMORY_MISS' ? '🔍'
      : s.decision === 'PR_CREATED' ? '✅'
      : s.outcome === 'merged' ? '🔵'
      : s.outcome === 'closed' ? '🔴'
      : '  ';
    const color = s.decision === 'LLM_GENERATED' ? yellow
      : s.decision === 'MEMORY_HIT' ? green
      : s.outcome === 'merged' ? green
      : s.outcome === 'closed' ? red
      : dim;

    const reasoning = s.reasoning_chain && s.reasoning_chain !== '[]'
      ? JSON.parse(s.reasoning_chain).join(' → ') : '';
    const truthInfo = s.outcome
      ? ` | truth_conf=${s.confidence_at_time} trust=${s.trust_score_at_time}`
      : '';

    console.log(`  ${color}${icon} ${s.step.padEnd(20)} ${(s.decision + truthInfo).padEnd(45)} ${(s.confidence * 100).toFixed(0)}%${reset}`);
    if (reasoning) console.log(`  ${dim}     └─ ${reasoning}${reset}`);
  }

  // Classify this event
  if (llmUsed && prCreated && truthRecorded) {
    console.log(`  ${yellow}→ Path: LLM → Candidate → Truth → Knowledge-ready${reset}`);
  } else if (llmUsed && prCreated && !truthRecorded) {
    console.log(`  ${yellow}→ Path: LLM → Candidate (awaiting truth)${reset}`);
  } else if (!llmUsed && prCreated) {
    console.log(`  ${green}→ Path: Knowledge → PR (no LLM)${reset}`);
  } else if (llmUsed && !prCreated) {
    console.log(`  ${red}→ Path: LLM → failed before PR${reset}`);
  }
}

// ── Step 2: Check patterns that are candidates vs promoted vs global ──
console.log(`\n${bold}━━━ KNOWLEDGE INVENTORY${reset}`);

const allPatterns = db.prepare(`
  SELECT id, fix_type, pattern_hash, confidence, times_used, times_accepted, times_rejected,
         repos, global,
         ROUND(100.0 * times_accepted / NULLIF(times_accepted + times_rejected, 0), 1) AS accept_rate
  FROM patterns
  ORDER BY global DESC, times_used DESC
`).all();

console.log(`  ${dim}Total patterns: ${allPatterns.length}${reset}`);
console.log();

for (const p of allPatterns) {
  const repoList = JSON.parse(p.repos || '[]');
  const repoCount = repoList.length;
  const isGlobal = p.global === 1;

  const status = isGlobal ? `${green}● GLOBAL${reset}`
    : repoCount >= 3 && p.accept_rate >= 75 ? `${yellow}● PROMOTABLE${reset}`
    : `${dim}○ candidate${reset}`;

  const bar = '█'.repeat(Math.min(Math.round(Math.min(p.accept_rate, 100) / 20), 5)) +
    '░'.repeat(Math.max(5 - Math.min(Math.round(Math.min(p.accept_rate, 100) / 20), 5), 0));

  console.log(`  ${status} ${bold}${p.fix_type}${reset} ${dim}(${p.pattern_hash.slice(0, 12)}…)${reset}`);
  console.log(`        used=${p.times_used} accepted=${p.times_accepted} rejected=${p.times_rejected} accept=${p.accept_rate}% ${bar}`);
  console.log(`        repos=${repoCount} confidence=${p.confidence.toFixed(2)}`);
}

// Check what would be promoted right now
const promotable = db.prepare(`
  SELECT fix_type, pattern_hash, confidence, times_used, times_accepted,
         ROUND(100.0 * times_accepted / NULLIF(times_accepted + times_rejected, 0), 1) AS accept_rate
  FROM patterns
  WHERE confidence >= 0.8 AND times_used >= 10 AND global = 0
    AND (SELECT COUNT(*) FROM json_each(repos)) >= 3
    AND ROUND(100.0 * times_accepted / NULLIF(times_accepted + times_rejected, 0), 1) >= 75
`).all();

if (promotable.length > 0) {
  console.log(`\n${green}● Would be promoted NOW:${reset}`);
  for (const p of promotable) {
    console.log(`    ${p.fix_type} ${dim}(${p.pattern_hash.slice(0, 12)}…)${reset} — used ${p.times_used}x, ${p.accept_rate}% accept, ${JSON.parse(p.repos || '[]').length} repos`);
  }
} else {
  console.log(`\n${dim}  No patterns meet promotion threshold yet${reset}`);
  console.log(`  ${dim}  Need: confidence≥0.8, used≥10x, ≥3 repos, accept≥75%${reset}`);
  const closest = db.prepare(`
    SELECT fix_type, pattern_hash, confidence, times_used, times_accepted,
           (SELECT COUNT(*) FROM json_each(repos)) AS repo_count,
           ROUND(100.0 * times_accepted / NULLIF(times_accepted + times_rejected, 0), 1) AS accept_rate
    FROM patterns WHERE global = 0 ORDER BY confidence * times_used DESC LIMIT 1
  `).get();
  if (closest) {
    console.log(`  ${dim}  Closest: ${closest.fix_type} — conf=${closest.confidence}, used=${closest.times_used}, repos=${closest.repo_count}, accept=${closest.accept_rate}%${reset}`);
  }
}

// ── Step 3: Check meta_policies (promoted knowledge) ──
const policies = db.prepare(`SELECT * FROM meta_policies`).all();
console.log(`\n${bold}━━━ PROMOTED POLICIES${reset}`);
if (policies.length > 0) {
  for (const p of policies) {
    console.log(`  ${green}●${reset} ${bold}${p.name}${reset}`);
    console.log(`    condition="${p.condition}" → action=${p.action}`);
    console.log(`    confidence=${p.confidence} repos=${p.repos_observed} validated=${p.times_validated} active=${p.active}`);
  }
} else {
  console.log(`  ${dim}(empty — no pattern has been promoted yet)${reset}`);
}

// ── Step 4: Truth calibrations ──
const cals = db.prepare(`SELECT * FROM truth_calibration ORDER BY metric`).all();
console.log(`\n${bold}━━━ TRUTH CALIBRATION STATE${reset}`);
if (cals.length > 0) {
  for (const c of cals) {
    const hist = c.history && c.history !== '[]' ? JSON.parse(c.history) : [];
    console.log(`  ${c.metric.padEnd(38)} value=${String(c.current_value).padStart(6)}  samples=${String(c.sample_size).padStart(4)}  history=[${hist.length} entries]`);
  }
} else {
  console.log(`  ${dim}(empty — awaits first truth event to calibrate)${reset}`);
}

// ── Step 5: The full lifecycle in one view ──
console.log(`\n${bold}━━━ KNOWLEDGE LIFECYCLE FLOW${reset}`);
console.log(`
  ${dim}LLM${reset}  ──→  ${yellow}Candidate${reset}  ──→  ${cyan}Truth${reset}  ──→  ${green}Policy${reset}
                  ┆              ┆              ┆
                  ├ patterns     ├ truth_events  ├ meta_policies
                  ├ conf=0.85    ├ merged/closed ├ condition
                  ├ used=15x     ├ conf_at_time  ├ action=auto_approve
                  └ hit=0        └ trust_score   └ confidence
`);
console.log(`  ${bold}Current state:${reset}`);
const totalPatterns = allPatterns.length;
const usedPatterns = allPatterns.filter(p => p.times_used > 0).length;
const promotableCount = promotable.length;
const policyCount = policies.length;
const accuracyRows = db.prepare(`SELECT SUM(total) AS total, SUM(correct) AS correct FROM accuracy_metrics`).get();

console.log(`    ${'Patterns stored:'.padEnd(25)} ${String(totalPatterns).padStart(3)}`);
console.log(`    ${'Patterns used (≥1x):'.padEnd(25)} ${String(usedPatterns).padStart(3)}`);
console.log(`    ${'Promotable (ready):'.padEnd(25)} ${String(promotableCount).padStart(3)}`);
console.log(`    ${'Promoted (policies):'.padEnd(25)} ${String(policyCount).padStart(3)}`);
console.log(`    ${'Truth events:'.padEnd(25)} ${String(db.prepare('SELECT COUNT(*) AS c FROM truth_events').get().c).padStart(3)}`);
console.log(`    ${'Accuracy tracked:'.padEnd(25)} ${String(accuracyRows.total || 0).padStart(3)} fixes`);
console.log(`\n  ${dim}Generated: ${new Date().toISOString()}${reset}`);
console.log();
