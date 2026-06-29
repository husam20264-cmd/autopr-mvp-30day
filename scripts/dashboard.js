#!/usr/bin/env node
import { getDb } from '../data/db.js';

function pad(s, len) {
  s = String(s);
  while (s.length < len) s = ' ' + s;
  return s;
}

function padRight(s, len) {
  s = String(s);
  while (s.length < len) s = s + ' ';
  return s;
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
  console.log('─'.repeat(50));
}

function printRow(label, value, width = 34) {
  console.log(`  ${padRight(label, width)} ${pad(value, 12)}`);
}

function printTable(rows, colLabels, colWidths) {
  const sep = '  ├' + colWidths.map(w => '─'.repeat(w + 2)).join('┼') + '┤';
  const header = '  │' + colLabels.map((l, i) => ` ${padRight(l, colWidths[i])}`).join(' │') + ' │';
  console.log('  ┌' + colWidths.map(w => '─'.repeat(w + 2)).join('┬') + '┐');
  console.log(header);
  console.log(sep);
  for (const row of rows) {
    console.log('  │' + row.map((v, i) => ` ${padRight(String(v), colWidths[i])}`).join(' │') + ' │');
  }
  console.log('  └' + colWidths.map(w => '─'.repeat(w + 2)).join('┴') + '┘');
}

const db = getDb();

// ── Core Pipeline Metrics ──
const reposScanned = db.prepare(`SELECT COUNT(*) AS c FROM repos`).get().c;
const reposEligible = db.prepare(`SELECT COUNT(*) AS c FROM repos WHERE installation_id > 0`).get().c;
const eventsTotal = db.prepare(`SELECT COUNT(*) AS c FROM events`).get().c;
const eventsCompleted = db.prepare(`SELECT COUNT(*) AS c FROM events WHERE status = 'completed'`).get().c;
const prsTotal = db.prepare(`SELECT COUNT(*) AS c FROM prs`).get().c;
const prsOpened = db.prepare(`SELECT COUNT(*) AS c FROM prs WHERE opened_at IS NOT NULL`).get().c;
const prsMerged = db.prepare(`SELECT COUNT(*) AS c FROM truth_events WHERE outcome = 'merged'`).get().c;
const prsClosed = db.prepare(`SELECT COUNT(*) AS c FROM truth_events WHERE outcome = 'closed'`).get().c;

// ── Pattern Metrics ──
const patternsTotal = db.prepare(`SELECT COUNT(*) AS c FROM patterns`).get().c;
const patternsUsed = db.prepare(`SELECT COALESCE(SUM(times_used),0) AS c FROM patterns`).get().c;
const patternsAccepted = db.prepare(`SELECT COALESCE(SUM(times_accepted),0) AS c FROM patterns`).get().c;
const patternsRejected = db.prepare(`SELECT COALESCE(SUM(times_rejected),0) AS c FROM patterns`).get().c;

// ── Accuracy Metrics ──
const accRows = db.prepare(`SELECT fix_type, total, correct, incorrect FROM accuracy_metrics`).all();
const accTotal = accRows.reduce((s, r) => s + r.total, 0);
const accCorrect = accRows.reduce((s, r) => s + r.correct, 0);
const accAccuracy = accTotal > 0 ? ((accCorrect / accTotal) * 100).toFixed(1) : 'N/A';

// ── Memory Metrics ──
const memEntries = db.prepare(`SELECT COUNT(*) AS c FROM memory_cache`).get().c;
const memHits = db.prepare(`SELECT COALESCE(SUM(hit_count),0) AS c FROM memory_cache`).get().c;

// ── Decision Logs ──
const decisionLogs = db.prepare(`SELECT COUNT(*) AS c FROM decision_logs`).get().c;
const avgDuration = db.prepare(`SELECT AVG(duration_ms) AS avg FROM decision_logs WHERE duration_ms > 0`).get().avg || 0;

// ── Rejections ──
const rejectionsTotal = db.prepare(`SELECT COUNT(*) AS c FROM rejections`).get().c;

// ── Knowledge Graph ──
const knodes = db.prepare(`SELECT COUNT(*) AS c FROM knowledge_nodes`).get().c;
const kedges = db.prepare(`SELECT COUNT(*) AS c FROM knowledge_edges`).get().c;

// ── Meta Learning ──
const metaRules = db.prepare(`SELECT COUNT(*) AS c FROM meta_rules WHERE active = 1`).get().c;
const metaBehaviors = db.prepare(`SELECT COUNT(*) AS c FROM meta_behaviors`).get().c;
const metaTraps = db.prepare(`SELECT COUNT(*) AS c FROM meta_trap_patterns`).get().c;

// ── Analytics Events ──
const analyticsTotal = db.prepare(`SELECT COUNT(*) AS c FROM analytics`).get().c;

// ── Patterns by Fix Type ──
const patternsByType = db.prepare(`
  SELECT fix_type, SUM(times_used) AS used, SUM(times_accepted) AS accepted,
         ROUND(100.0 * SUM(times_accepted) / NULLIF(SUM(times_accepted + times_rejected), 0), 1) AS accept_rate
  FROM patterns GROUP BY fix_type ORDER BY used DESC
`).all();

// ── Accuracy by Fix Type ──
const accuracyByType = db.prepare(`
  SELECT fix_type, SUM(total) AS total, SUM(correct) AS correct,
         ROUND(100.0 * SUM(correct) / NULLIF(SUM(total),0), 1) AS accuracy
  FROM accuracy_metrics GROUP BY fix_type ORDER BY total DESC
`).all();

// ── Decision Pipeline Funnel ──
const pipelineSteps = db.prepare(`
  SELECT step, COUNT(*) AS count, ROUND(AVG(confidence), 2) AS avg_conf
  FROM decision_logs GROUP BY step ORDER BY MIN(id)
`).all();

// ── Render Dashboard ──
console.log(`
╔══════════════════════════════════════════════════════╗
║           \x1b[1;36mAutoPR — Real-Time Dashboard\x1b[0m                ║
╚══════════════════════════════════════════════════════╝
`);

section('PIPELINE OVERVIEW');
printRow('Repositories scanned', reposScanned);
printRow('Eligible repositories', reposEligible);
printRow('Events processed', eventsTotal);
printRow('Pipeline completions', eventsCompleted);
printRow('Decision logs recorded', decisionLogs);
printRow('Patches generated', prsTotal);
printRow('Patches verified', prsOpened);
printRow('PRs created', prsOpened);
printRow('PRs merged', prsMerged);
printRow('PRs closed (unmerged)', prsClosed);
const mergeRate = prsMerged + prsClosed > 0 ? ((prsMerged / (prsMerged + prsClosed)) * 100).toFixed(1) : '0.0';
printRow('Merge rate', mergeRate + '%');
const eventCompletionRate = eventsTotal > 0 ? ((eventsCompleted / eventsTotal) * 100).toFixed(1) : '0.0';
printRow('Event completion rate', eventCompletionRate + '%');

section('PATTERN SYSTEM');
printRow('Patterns learned', patternsTotal);
printRow('Pattern applications', patternsUsed);
printRow('Pattern accepts', patternsAccepted);
printRow('Pattern rejections', patternsRejected);
const patternAcceptRateDenom = parseInt(db.prepare(`SELECT COALESCE(SUM(times_accepted + times_rejected),0) AS c FROM patterns`).get().c);
const patternAcceptRate = patternAcceptRateDenom > 0 ? ((patternsAccepted / patternAcceptRateDenom) * 100).toFixed(1) : '0.0';
printRow('Pattern acceptance rate', patternAcceptRate + '%');
printRow('Memory cache entries', memEntries);
printRow('Memory cache hits', memHits);
const memTrace = db.prepare(`
  SELECT CAST(SUM(CASE WHEN decision = 'MEMORY_HIT' THEN 1 ELSE 0 END) AS REAL) /
    NULLIF(SUM(CASE WHEN step = 'memory_lookup' THEN 1 ELSE 0 END), 0) AS hit_rate
  FROM decision_logs
`).get();
const memHitRate = memTrace.hit_rate ? (memTrace.hit_rate * 100).toFixed(1) : '0.0';
printRow('Memory hit rate (trace)', memHitRate + '%');

section('ACCURACY METRICS');
printRow('Total fixes tracked', accTotal);
printRow('Correct fixes', accCorrect);
printRow('Accuracy', accAccuracy + '%');
printRow('Rejections logged', rejectionsTotal);

if (accuracyByType.length > 0) {
  console.log('\n  Accuracy by fix type:');
  printTable(
    accuracyByType.map(r => [r.fix_type, r.total, r.correct, r.accuracy + '%']),
    ['Fix Type', 'Total', 'Correct', 'Accuracy'],
    [16, 8, 8, 10]
  );
}

section('PATTERNS BY FIX TYPE');
if (patternsByType.length > 0) {
  printTable(
    patternsByType.map(r => [r.fix_type, r.used, r.accepted, r.accept_rate + '%']),
    ['Fix Type', 'Used', 'Accepted', 'Accept Rate'],
    [16, 8, 10, 12]
  );
}

section('PIPELINE FUNNEL');
if (pipelineSteps.length > 0) {
  const maxCount = Math.max(...pipelineSteps.map(s => s.count));
  for (const step of pipelineSteps) {
    const barLen = Math.round((step.count / maxCount) * 30);
    const bar = '█'.repeat(barLen) + '░'.repeat(30 - barLen);
    console.log(`  ${padRight(step.step, 22)} ${pad(step.count, 4)}  ${bar}  conf:${step.avg_conf}`);
  }
}

section('KNOWLEDGE & META');
printRow('Knowledge nodes', knodes);
printRow('Knowledge edges', kedges);
printRow('Active meta rules', metaRules);
printRow('Meta behaviors', metaBehaviors);
printRow('Trap patterns', metaTraps);
printRow('Analytics events', analyticsTotal);

// ── AI Cost Estimate ──
const avgCostPerPR = prsTotal > 0 ? (0.03 * prsTotal / Math.max(prsOpened, 1)).toFixed(2) : '0.00';
printRow('Avg LLM cost per PR', '$' + avgCostPerPR);

console.log(`\n  \x1b[2mGenerated: ${new Date().toISOString()}\x1b[0m`);
console.log();
