import { getDb, closeDb } from '../data/db.js';

const db = getDb();

function jparse(s) { try { return JSON.parse(s); } catch { return []; } }

// ── Load ESR history ──
const esrRow = db.prepare("SELECT history, sample_size FROM truth_calibration WHERE metric = 'esr_score'").get();
if (!esrRow || esrRow.sample_size < 2) {
  console.log('\n═══ Causal Inconsistency Test ═══\n');
  console.log('  Need ≥2 ESR data points (have ' + (esrRow ? esrRow.sample_size : 0) + ').');
  console.log('  Run esr_score.js after the next pilot run.\n');
  process.exit(0);
}

const esrHistory = jparse(esrRow.history);
const n = esrHistory.length;

// ── Compute ESR per point ──
const esrPoints = esrHistory.map(h => h.score);

// ── Compute calibration divergence per ESR point ──
// Use the truth_calibration snapshots as proxy for system state
const calRows = db.prepare("SELECT metric, current_value, sample_size, last_calibrated FROM truth_calibration WHERE metric NOT LIKE 'baseline:%' AND metric NOT LIKE 'esr_%' AND metric NOT LIKE 'entropy_%'").all();

// Group thresholds by their last_calibrated date to match ESR timeline
// For simplicity: compute current divergence and the divergence at each ESR point
// by looking at history fields
const calWithHistory = db.prepare("SELECT metric, history FROM truth_calibration WHERE metric NOT LIKE 'baseline:%' AND metric NOT LIKE 'esr_%' AND metric NOT LIKE 'entropy_%' AND history IS NOT NULL").all();

// ── Method: compute explainability as R² between ESR and threshold mean ──
// For each ESR point, we need the average threshold value at that time.
// Since we don't have exact timestamps matching, we use the latest snapshot
// as the current state.

// Current calibration summary
const thresholds = calRows.map(r => r.current_value);
const calMean = thresholds.reduce((s, v) => s + v, 0) / thresholds.length;
const calMin = Math.min(...thresholds);
const calMax = Math.max(...thresholds);
const calRange = calMax - calMin;
const calVar = thresholds.reduce((s, v) => s + Math.pow(v - calMean, 2), 0) / thresholds.length;

// ESR summary
const esrMean = esrPoints.reduce((s, v) => s + v, 0) / n;
const esrVar = esrPoints.reduce((s, v) => s + Math.pow(v - esrMean, 2), 0) / n;

// ── Consistency test: does ESR movement track calibration movement? ──
// If both are high-variance together → consistent single regime
// If ESR moves while calibration static → decoupling (emergence candidate)

// Use calibration history to track divergence over time
// Each calibration metric has a history array of {accepted, date} or {date, ...}
// We'll compute divergence at 3 snapshots: earliest, middle, latest

function getCalDivergenceAtTime(targetDate) {
  // For each metric with history, find the value closest to targetDate
  const values = [];
  for (const row of calWithHistory) {
    const hist = jparse(row.history);
    if (!hist || hist.length === 0) continue;
    // Find entry closest to targetDate
    let closest = hist[0];
    let closestDelta = Infinity;
    for (const entry of hist) {
      const d = entry.date || entry.last_calibrated;
      if (!d) continue;
      const delta = Math.abs(new Date(d).getTime() - new Date(targetDate).getTime());
      if (delta < closestDelta) {
        closestDelta = delta;
        closest = entry;
      }
    }
    // Extract value: could be current_value, accepted (boolean), or score
    if (closest.current_value != null) values.push(closest.current_value);
    else if (closest.accepted != null) values.push(closest.accepted ? 1 : 0);
    else if (closest.score != null) values.push(closest.score);
  }
  if (values.length < 2) return null;
  return Math.max(...values) - Math.min(...values);
}

// Compute divergence at each ESR point
const divergences = [];
for (const point of esrHistory) {
  const div = getCalDivergenceAtTime(point.date);
  if (div != null) divergences.push(div);
}

// ── Compute ESR-divergence correlation ──
let rSquared = 0;
if (divergences.length >= 3 && esrPoints.length >= 3) {
  const len = Math.min(divergences.length, esrPoints.length);
  const dSlice = divergences.slice(-len);
  const eSlice = esrPoints.slice(-len);
  const dMean = dSlice.reduce((s, v) => s + v, 0) / len;
  const eMean2 = eSlice.reduce((s, v) => s + v, 0) / len;
  const num = dSlice.reduce((s, d, i) => s + (d - dMean) * (eSlice[i] - eMean2), 0);
  const den = Math.sqrt(
    dSlice.reduce((s, d) => s + Math.pow(d - dMean, 2), 0) *
    eSlice.reduce((s, e) => s + Math.pow(e - eMean2, 2), 0)
  );
  rSquared = den > 0 ? Math.pow(num / den, 2) : 0;
}

// ── Interpret ──
const esrSlope = esrPoints.length >= 2
  ? (esrPoints[esrPoints.length - 1] - esrPoints[0]) / (esrPoints.length - 1)
  : 0;

let verdict;
if (esrVar < 0.001) {
  verdict = { label: 'NO SIGNAL — ESR is flat', type: 'static', consistent: true };
} else if (calVar < 0.001 && esrVar >= 0.001) {
  verdict = { label: 'DECOUPLING CANDIDATE — ESR moves, calibration does not', type: 'emergence_candidate', consistent: false };
} else if (rSquared > 0.7) {
  verdict = { label: 'SELF-CONSISTENT — ESR and calibration move together', type: 'stable_regime', consistent: true };
} else if (rSquared > 0.3) {
  verdict = { label: 'WEAK COUPLING — partial decoupling, monitor next runs', type: 'transition_candidate', consistent: false };
} else if (divergences.length >= 3) {
  verdict = { label: 'DECOUPLED — ESR not explained by calibration', type: 'emergence', consistent: false };
} else {
  verdict = { label: 'INSUFFICIENT DATA', type: 'unknown', consistent: null };
}

// ── Output ──
console.log('\n═══ Causal Inconsistency Test ═══\n');
console.log(`  ESR points:         ${n}`);
console.log(`  ESR range:          [${Math.min(...esrPoints).toFixed(3)}, ${Math.max(...esrPoints).toFixed(3)}]`);
console.log(`  ESR variance:       ${esrVar.toFixed(6)}`);
console.log(`  ESR slope:          ${esrSlope > 0 ? '+' : ''}${esrSlope.toFixed(4)}/run`);
console.log(`  Cal thresholds:     ${thresholds.length}`);
console.log(`  Cal mean:           ${calMean.toFixed(4)}`);
console.log(`  Cal range:          ${calRange.toFixed(4)}`);
console.log(`  Cal variance:       ${calVar.toFixed(6)}`);
console.log(`  ESR↔Cal R²:         ${rSquared.toFixed(4)}`);
console.log(`  Divergence points:  ${divergences.length}`);

if (divergences.length >= 2) {
  console.log(`  Divergence history: ${divergences.map(d => d.toFixed(3)).join(' → ')}`);
  const divSlope = (divergences[divergences.length - 1] - divergences[0]) / (divergences.length - 1);
  console.log(`  Divergence slope:   ${divSlope > 0 ? '+' : ''}${divSlope.toFixed(4)}/run`);
}

console.log(`\n  ── Verdict ──`);
console.log(`  ${verdict.label}`);
console.log(`  Consistent regime:  ${verdict.consistent === true ? '✅ yes' : verdict.consistent === false ? '❌ no' : '❓ unknown'}`);

if (verdict.type === 'emergence_candidate' || verdict.type === 'emergence') {
  console.log(`\n  ⚠️  ESR is moving independently from calibration.`);
  console.log(`  This is the first true emergence signal — the system`);
  console.log(`  is no longer fully explained by its calibration layer.`);
  console.log(`  Cross-reference with emergence_map.md for confirmation.`);
}
console.log('');

// ── Persist ──
const entry = { date: new Date().toISOString(), esrVar, calVar, rSquared, verdict: verdict.type };
const prev = db.prepare("SELECT history FROM truth_calibration WHERE metric = 'causal_test'").get();
const history = prev ? jparse(prev.history) : [];
history.push(entry);
db.prepare(`INSERT OR REPLACE INTO truth_calibration (metric, current_value, sample_size, last_calibrated, history)
  VALUES ('causal_test', ?, ?, datetime('now'), ?)`)
  .run(rSquared, n, JSON.stringify(history));

closeDb();
