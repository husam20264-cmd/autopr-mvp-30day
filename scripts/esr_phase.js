import { getDb, closeDb } from '../data/db.js';

const db = getDb();

function jparse(s) { try { return JSON.parse(s); } catch { return []; } }

// ── Load ESR history ──
const row = db.prepare("SELECT current_value, sample_size, history FROM truth_calibration WHERE metric = 'esr_score'").get();
if (!row) {
  console.log('No ESR data found. Run node scripts/esr_score.js first.');
  process.exit(0);
}

const history = jparse(row.history);
const n = history.length;
const current = row.current_value;

if (n < 2) {
  console.log(`\n═══ ESR Phase Detector ═══\n`);
  console.log(`  Phase: ESR-? (need ≥2 data points)`);
  console.log(`  Current ESR: ${current.toFixed(3)}`);
  console.log(`  Samples: ${n}/2 minimum`);
  console.log(`  Run node scripts/esr_score.js again after next pilot run.\n`);
  process.exit(0);
}

// ── 1. Linear regression for slope ──
const points = history.map((h, i) => ({ x: i, y: h.score }));
const sumX = points.reduce((s, p) => s + p.x, 0);
const sumY = points.reduce((s, p) => s + p.y, 0);
const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0);
const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
const intercept = (sumY - slope * sumX) / n;

// ── 2. Slope interpretation ──
const slopeLabel = slope > 0.02 ? '↑ rising' : slope < -0.02 ? '↓ falling' : '→ flat';

// ── 3. Phase label ──
let phase, nextPhase, nextAt;
if (current < 0.1) {
  phase = 'ESR-1 (stable fixed-point)';
  nextPhase = 'ESR-2 (transition)';
  nextAt = nextAt = n + Math.ceil((0.1 - current) / Math.max(slope, 0.001));
} else if (current < 0.3) {
  phase = 'ESR-2 (transition)';
  nextPhase = 'ESR-3 (unstable learning)';
  nextAt = n + Math.ceil((0.3 - current) / Math.max(slope, 0.001));
} else if (current < 0.7) {
  phase = 'ESR-3 (unstable learning)';
  nextPhase = 'ESR-4 (mature adaptive)';
  nextAt = n + Math.ceil((0.7 - current) / Math.max(slope, 0.001));
} else {
  phase = 'ESR-4 (mature adaptive)';
  nextPhase = null;
  nextAt = null;
}

// ── 4. Confidence estimate ──
// Based on: sample count, slope stability (R² proxy), sequence length
const variance = points.reduce((s, p) => s + Math.pow(p.y - (slope * p.x + intercept), 2), 0) / n;
const meanY = sumY / n;
const totalVariance = points.reduce((s, p) => s + Math.pow(p.y - meanY, 2), 0) / n;
const rSquared = totalVariance > 0 ? 1 - variance / totalVariance : 0;
const sampleConf = Math.min(1, n / 10);
const rConf = Math.max(0, Math.min(1, rSquared));
const confidence = +((sampleConf * 0.4 + rConf * 0.6)).toFixed(3);

// ── 5. Recent acceleration ──
const recent = points.slice(-Math.min(3, points.length));
const recentSlope = recent.length >= 2
  ? (recent[recent.length-1].y - recent[0].y) / (recent.length - 1)
  : slope;

// ── Output ──
console.log(`\n═══ ESR Phase Detector ═══\n`);
console.log(`  Phase:             ${phase}`);
console.log(`  ESR Score:         ${current.toFixed(3)} / 1.000`);
console.log(`  Slope (overall):   ${slopeLabel} (${slope > 0 ? '+' : ''}${slope.toFixed(4)}/run)`);
console.log(`  Recent Δ:          ${recentSlope > 0 ? '+' : ''}${recentSlope.toFixed(4)}/run`);
console.log(`  R²:                ${rSquared.toFixed(3)}`);
console.log(`  Confidence:        ${(confidence * 100).toFixed(1)}%`);
console.log(`  Data points:       ${n}`);
if (nextPhase && slope > 0.001) {
  console.log(`  Next phase:        ${nextPhase} (≈ run #${nextAt})`);
} else if (nextPhase) {
  console.log(`  Next phase:        ${nextPhase} (slope too flat to estimate)`);
} else {
  console.log(`  Next phase:        at maturity`);
}
console.log(`\n  ESR History: ${history.map(h => h.score.toFixed(3)).join(' → ')}`);
console.log('');

// ── Persist phase for trend tracking ──
const entry = { date: new Date().toISOString(), phase, esr: current, slope, rSquared, confidence, n };
const phaseRow = db.prepare("SELECT history FROM truth_calibration WHERE metric = 'esr_phase'").get();
const phaseHistory = phaseRow ? jparse(phaseRow.history) : [];
phaseHistory.push(entry);
db.prepare(`INSERT OR REPLACE INTO truth_calibration (metric, current_value, sample_size, last_calibrated, history)
  VALUES ('esr_phase', ?, ?, datetime('now'), ?)`)
  .run(confidence, n, JSON.stringify(phaseHistory));

closeDb();
