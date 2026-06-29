import { getDb, closeDb } from '../data/db.js';

const db = getDb();

function one(sql, p = {}) { return db.prepare(sql).get(p); }
function all(sql, p = {}) { return db.prepare(sql).all(p); }

// ── Helper: safe JSON parse ──
function jparse(s) { try { return JSON.parse(s); } catch { return []; } }

// ── Signal 1: Fix-Type Entropy ──
// Score 0.0–1.0: proportion of non-dominant fix types above 10% threshold
function signal_entropy() {
  const total = one('SELECT COUNT(*) AS n FROM truth_events').n;
  if (total === 0) return { score: 0, detail: 'no events' };
  const types = all('SELECT fix_type, COUNT(*) AS n FROM truth_events GROUP BY fix_type ORDER BY n DESC');
  const pcts = types.map(t => ({ fix_type: t.fix_type, pct: t.n / total }));
  const above10 = pcts.filter(p => p.pct >= 0.1).length;
  const score = Math.min(1, Math.max(0, (above10 - 1) / 2)); // 0 if only 1 type ≥10%, 1 if 3+ types
  return { score: +score.toFixed(3), detail: pcts.map(p => `${p.fix_type}=${(p.pct*100).toFixed(1)}%`).join(', ') };
}

// ── Signal 2: Pattern Dominance Shift ──
// Score 0.0–1.0: 0 if single pattern dominates ≥80% of apps, 1 if no pattern >50%
function signal_pattern_shift() {
  const total = one('SELECT COALESCE(SUM(times_used),0) AS n FROM patterns').n;
  if (total === 0) return { score: 0, detail: 'no pattern usage' };
  const pats = all('SELECT fix_type, pattern_hash, times_used FROM patterns WHERE times_used > 0 ORDER BY times_used DESC');
  const pcts = pats.map(p => ({ label: `${p.fix_type.slice(0,12)}:${p.pattern_hash.slice(0,8)}`, pct: p.times_used / total }));
  const topPct = pcts.length > 0 ? pcts[0].pct : 1;
  // score = 1 - topPct, so if top=80% → 0.2, if top=40% → 0.6
  const score = Math.min(1, Math.max(0, 1 - topPct));
  return { score: +score.toFixed(3), detail: pcts.map(p => `${p.label}=${(p.pct*100).toFixed(1)}%`).join(', ') };
}

// ── Signal 3: Calibration Divergence ──
// Score 0.0–1.0: scaled divergence of per-repo thresholds with ≥10 samples
function signal_calibration_divergence() {
  const rows = all(`SELECT metric, current_value, sample_size FROM truth_calibration
    WHERE metric NOT LIKE 'baseline:%' AND sample_size >= 10 ORDER BY current_value ASC`);
  if (rows.length < 2) return { score: 0, detail: `only ${rows.length} thresholds with ≥10 samples` };
  const vals = rows.map(r => r.current_value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const divergence = max - min;
  const score = Math.min(1, Math.max(0, divergence / 0.5)); // 0.3 divergence → 0.6, 0.5+ → 1.0
  return { score: +score.toFixed(3), detail: `range [${min.toFixed(3)}, ${max.toFixed(3)}] = ${divergence.toFixed(3)} (${rows.length} thresholds)` };
}

// ── Signal 4: Merge Rate Regime Change ──
// Score 0.0–1.0: 0 if within [0.90, 1.0] band, 1 if outside for 2+ snapshots
function signal_merge_regime() {
  const row = one(`SELECT history FROM truth_calibration WHERE metric = 'baseline:v1_snapshot'`);
  if (!row) return { score: 0, detail: 'no baseline history' };
  const hist = jparse(row.history);
  const rates = hist.map(h => ({ rate: parseFloat(h.merge_rate), events: h.truth_events })).filter(h => !isNaN(h.rate));
  // Check last 2 snapshots
  const recent = rates.slice(-2);
  if (recent.length < 2) return { score: 0, detail: `only ${recent.length} snapshots` };
  const outside = recent.filter(r => r.rate < 90 || r.rate > 99);
  const score = outside.length >= 2 ? 1.0 : 0.0;
  return { score, detail: `last 2 rates: ${recent.map(r => r.rate + '%').join(', ')}` };
}

// ── Signal 5: Policy Competition ──
// Score 0.0–1.0: based on whether multiple active policies exist per fix_type
function signal_policy_competition() {
  const policies = all(`SELECT name, source_pattern, confidence FROM meta_policies WHERE active = 1`);
  if (policies.length < 2) return { score: 0, detail: `${policies.length} active policies` };
  // Check if any policies share a source_pattern domain
  const bySource = {};
  for (const p of policies) {
    const src = p.source_pattern || 'generic';
    if (!bySource[src]) bySource[src] = [];
    bySource[src].push(p.name);
  }
  const competing = Object.entries(bySource).filter(([_, ps]) => ps.length > 1).length;
  const totalSources = Object.keys(bySource).length;
  const score = totalSources > 0 ? Math.min(1, competing / totalSources) : 0;
  return { score: +score.toFixed(3), detail: `${competing}/${totalSources} source patterns with competing policies` };
}

// ── Signal 6: Reuse Rate Stabilization at Second Level ──
// Score 0.0–1.0: only meaningful when fix_type entropy >0; for now, 0
function signal_reuse_stabilization() {
  const total = one('SELECT COUNT(*) AS n FROM truth_events').n;
  const patApps = one('SELECT COALESCE(SUM(times_used),0) AS n FROM patterns').n;
  const rate = total > 0 ? patApps / total : 0;
  return { score: 0, detail: `reuse rate ${(rate*100).toFixed(1)}% — needs 2nd fix type to stabilize` };
}

// ── Compute ESR Score ──
const signals = [
  { name: 'fix_type_entropy',          fn: signal_entropy },
  { name: 'pattern_dominance_shift',   fn: signal_pattern_shift },
  { name: 'calibration_divergence',    fn: signal_calibration_divergence },
  { name: 'merge_regime_change',       fn: signal_merge_regime },
  { name: 'policy_competition',        fn: signal_policy_competition },
  { name: 'reuse_stabilization',       fn: signal_reuse_stabilization },
];

console.log('\n═══ ESR Signal Scores ═══\n');
let total = 0;
for (const s of signals) {
  const r = s.fn();
  total += r.score;
  console.log(`  ${s.name}: ${r.score.toFixed(3)}  (${r.detail})`);
}

const esrScore = total / signals.length;
console.log(`\n  ─────────────────────────────`);
console.log(`  ESR Score: ${esrScore.toFixed(3)} / 1.000`);
console.log(`  Phase: ${esrScore < 0.1 ? 'ESR-1 (stable fixed-point)' : esrScore < 0.3 ? 'ESR-2 (transition)' : 'MLR (multi-regime)'}`);

// Trend: compare against stored history if available
const prev = one("SELECT current_value, history FROM truth_calibration WHERE metric = 'esr_score'");
let history = [];
if (prev) {
  const delta = esrScore - prev.current_value;
  console.log(`  Trend: ${delta > 0.01 ? '↑ improving' : delta < -0.01 ? '↓ declining' : '→ stable'} (Δ=${delta.toFixed(3)})`);
  history = jparse(prev.history);
}
console.log('');

// Persist with accumulated history
const entry = { date: new Date().toISOString(), score: esrScore, signals: signals.map(s => ({ name: s.name, score: s.fn().score })) };
history.push(entry);
const sampleSize = history.length;
const stmt = db.prepare(`INSERT OR REPLACE INTO truth_calibration (metric, current_value, sample_size, last_calibrated, history)
  VALUES ('esr_score', ?, ?, datetime('now'), ?)`);
stmt.run(esrScore, sampleSize, JSON.stringify(history));
console.log(`  History: ${sampleSize} data point${sampleSize > 1 ? 's' : ''}`);

closeDb();
