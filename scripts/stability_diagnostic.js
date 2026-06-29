import { getDb, closeDb } from '../data/db.js';

const db = getDb();

function jparse(s) { try { return JSON.parse(s); } catch { return []; } }

// ── Load ESR history ──
const row = db.prepare("SELECT history FROM truth_calibration WHERE metric = 'esr_score'").get();
if (!row) { console.log('No ESR data.'); process.exit(0); }

const history = jparse(row.history);
const n = history.length;
if (n < 3) {
  console.log(`\n═══ Stability Diagnostic Overlay ═══\n`);
  console.log(`  Need ≥3 data points (have ${n})`);
  console.log(`  Current regime: noise dominated`);
  console.log(`  Diagnostics unreliable until n ≥ 5.\n`);
  process.exit(0);
}

const scores = history.map(h => h.score);

// ── 1. Phase label stability ──
function phaseLabel(esr) {
  if (esr < 0.1) return 'ESR-1';
  if (esr < 0.3) return 'ESR-2';
  if (esr < 0.7) return 'ESR-3';
  return 'ESR-4';
}
const labels = scores.map(phaseLabel);
const uniqueLabels = [...new Set(labels)];
const phaseFlips = labels.slice(1).reduce((c, l, i) => c + (l !== labels[i] ? 1 : 0), 0);

// ── 2. Running slope at each window size ──
function slopeOf(points) {
  const m = points.length;
  const sx = points.reduce((s, p, i) => s + i, 0);
  const sy = points.reduce((s, p) => s + p, 0);
  const sxy = points.reduce((s, p, i) => s + i * p, 0);
  const sx2 = points.reduce((s, _, i) => s + i * i, 0);
  const denom = m * sx2 - sx * sx;
  if (denom === 0) return 0;
  return (m * sxy - sx * sy) / denom;
}

const slopes = [];
for (let i = 2; i <= n; i++) {
  slopes.push({ at: i, slope: slopeOf(scores.slice(0, i)) });
}

// ── 3. Slope convergence ──
const last3 = slopes.slice(-3);
const slopeRange = last3.length >= 2 ? Math.max(...last3.map(s => s.slope)) - Math.min(...last3.map(s => s.slope)) : Infinity;

// ── 4. Effective noise: mean absolute deviation of recent residuals ──
const allSlope = slopeOf(scores);
const residuals = scores.map((s, i) => Math.abs(s - (allSlope * i + (scores.reduce((a, b) => a + b, 0) - allSlope * (n-1) / 2) / n)));
const meanResidual = residuals.reduce((a, b) => a + b, 0) / n;

// ── 5. Signal-to-noise ratio ──
const scoreRange = Math.max(...scores) - Math.min(...scores);
const snr = meanResidual > 0 ? scoreRange / meanResidual : 0;

// ── 6. Regime classification ──
function regimeLabel(n, snr, phaseFlips, slopeRange) {
  if (n < 5) return { label: 'noise dominated', color: '🔴' };
  if (n < 10) {
    if (snr < 1.5 || phaseFlips >= n/2) return { label: 'weak structure (high noise)', color: '🟠' };
    return { label: 'emerging structure', color: '🟡' };
  }
  if (phaseFlips > 0 && slopeRange > 0.02) return { label: 'interpretable but unstable', color: '🟡' };
  if (snr < 2) return { label: 'interpretable, low contrast', color: '🟢' };
  return { label: 'stable signal regime', color: '🟢' };
}
const regime = regimeLabel(n, snr, phaseFlips, slopeRange);

// ── 7. Regime transition predictor ──
let noiseToEmergent = Math.max(0, 5 - n);
let emergentToInterpretable = Math.max(0, 10 - n);

// ── Output ──
console.log(`\n═══ Stability Diagnostic Overlay ═══\n`);
console.log(`  Samples:          ${n}`);
console.log(`  Regime:           ${regime.color} ${regime.label}`);
console.log(`  Phase labels:     ${uniqueLabels.join(', ')}${phaseFlips > 0 ? ` (${phaseFlips} flip${phaseFlips > 1 ? 's' : ''})` : ' (stable)'}`);
console.log(`  ESR range:        [${Math.min(...scores).toFixed(3)}, ${Math.max(...scores).toFixed(3)}] (Δ = ${scoreRange.toFixed(3)})`);
console.log(`  SNR:              ${snr.toFixed(2)} (residual σ = ${meanResidual.toFixed(4)})`);
console.log(`  Slope history:    ${slopes.map(s => s.at + ':' + s.slope.toFixed(4)).join(' → ')}`);
console.log(`  Slope range (last 3): ${slopeRange.toFixed(4)}`);
console.log(`  Current slope:    ${allSlope > 0 ? '+' : ''}${allSlope.toFixed(4)}/run`);

console.log(`\n  ── Regime thresholds ──`);
console.log(`  ${n >= 5 ? '✅' : '  '} n ≥ 5  (${noiseToEmergent > 0 ? `${noiseToEmergent} more run${noiseToEmergent > 1 ? 's' : ''}` : 'passed'}) → exit noise domination`);
console.log(`  ${n >= 10 ? '✅' : '  '} n ≥ 10 (${emergentToInterpretable > 0 ? `${emergentToInterpretable} more run${emergentToInterpretable > 1 ? 's' : ''}` : 'passed'}) → enter interpretable regime`);

console.log(`\n  ── Verdict ──`);
if (n < 5) console.log('  🔴 Phase labels and slope are statistically meaningless.');
else if (n < 10) console.log('  🟡 Phase labels may still flip. Do not trust trend direction yet.');
else if (phaseFlips > 0) console.log('  🟡 Phase is not yet locked. Watch for label stabilization.');
else console.log('  🟢 Phase and slope are structurally interpretable.');

const next = `  Next meaningful point: run #${Math.max(5, Math.min(10, n + 1))} (${n < 5 ? 'exit noise' : n < 10 ? 'approach interpretable' : 'monitor stability'})`;
console.log(next);
console.log('');

closeDb();
