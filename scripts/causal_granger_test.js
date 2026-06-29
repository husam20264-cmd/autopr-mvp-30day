import { getDb, closeDb } from '../data/db.js';

const db = getDb();

function jparse(s) { try { return JSON.parse(s); } catch { return []; } }

// ── Load ESR time series ──
const esrRow = db.prepare("SELECT history, sample_size FROM truth_calibration WHERE metric = 'esr_score'").get();
if (!esrRow || esrRow.sample_size < 3) {
  console.log('\n═══ Granger Causality Test ═══\n');
  console.log(`  Need ≥3 ESR data points (have ${esrRow ? esrRow.sample_size : 0}).\n`);
  process.exit(0);
}

const esrHist = jparse(esrRow.history);
const n = esrHist.length;
const esrSeries = esrHist.map(h => h.score);

// ── Load calibration divergence series ──
// Use divergence of per-repo/type thresholds at each time point
// For simplicity: compute average calibration value over all thresholds
// as a proxy for overall calibration state at each ESR point
const calDivSeries = [];
for (const point of esrHist) {
  // Get all thresholds with a history entry near this point's date
  const thresholds = db.prepare(`
    SELECT metric, current_value, history FROM truth_calibration
    WHERE metric NOT LIKE 'baseline:%'
      AND metric NOT LIKE 'esr_%'
      AND metric NOT LIKE 'entropy_%'
      AND metric NOT LIKE 'causal_%'
  `).all();

  let values = [];
  for (const t of thresholds) {
    const hist = jparse(t.history);
    if (hist.length === 0) continue;
    // Find the value closest to this ESR point's date
    let closest = hist[0];
    let minDelta = Infinity;
    for (const entry of hist) {
      const d = entry.date || entry.last_calibrated;
      if (!d) continue;
      const delta = Math.abs(new Date(d).getTime() - new Date(point.date).getTime());
      if (delta < minDelta) { minDelta = delta; closest = entry; }
    }
    const v = closest.current_value ?? (closest.accepted != null ? (closest.accepted ? 1 : 0) : null);
    if (v != null) values.push(v);
  }
  const mean = values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  calDivSeries.push(mean);
}

if (esrSeries.length < 3 || calDivSeries.length < 3) {
  console.log('\n═══ Granger Causality Test ═══\n');
  console.log('  Insufficient aligned calibration data.\n');
  process.exit(0);
}

// ── Granger test: does ESR_{t-1} predict Cal_t beyond Cal_{t-1}? ──
function fitModel(X, y) {
  const m = X.length;
  if (m < 2) return { rSquared: 0, aic: Infinity, coefs: [] };
  // Add intercept column
  const XwithIntercept = X.map(row => [1, ...row]);
  const k = XwithIntercept[0].length;

  // OLS: β = (X'X)^(-1) X'y
  // Simple approach for small k
  const XtX = Array.from({ length: k }, () => Array(k).fill(0));
  const Xty = Array(k).fill(0);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < k; j++) {
      Xty[j] += XwithIntercept[i][j] * y[i];
      for (let l = 0; l < k; l++) {
        XtX[j][l] += XwithIntercept[i][j] * XwithIntercept[i][l];
      }
    }
  }

  // Gaussian elimination for (X'X)β = X'y
  const aug = XtX.map((row, i) => [...row, Xty[i]]);
  for (let col = 0; col < k; col++) {
    let maxRow = col;
    for (let row = col + 1; row < k; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-10) return { rSquared: 0, aic: Infinity, coefs: Array(k).fill(0) };
    for (let j = col; j <= k; j++) aug[col][j] /= pivot;
    for (let row = 0; row < k; row++) {
      if (row !== col) {
        const factor = aug[row][col];
        for (let j = col; j <= k; j++) aug[row][j] -= factor * aug[col][j];
      }
    }
  }
  const coefs = aug.map(row => row[k]);

  // Compute R² and AIC
  const yMean = y.reduce((s, v) => s + v, 0) / m;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < m; i++) {
    const pred = XwithIntercept[i].reduce((s, x, j) => s + x * coefs[j], 0);
    ssRes += Math.pow(y[i] - pred, 2);
    ssTot += Math.pow(y[i] - yMean, 2);
  }
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const aic = m > k ? m * Math.log(ssRes / m) + 2 * k : Infinity;

  return { rSquared, aic, coefs };
}

// Build lagged datasets
// Model 0: Cal_t = α + β₁·Cal_{t-1}
// Model 1: Cal_t = α + β₁·Cal_{t-1} + β₂·ESR_{t-1}

const maxLag = Math.min(n - 1, Math.floor(n / 2));
let bestLag = 1;
let bestDeltaR2 = 0;

for (let lag = 1; lag <= maxLag; lag++) {
  const m = n - lag;
  const X0 = calDivSeries.slice(0, m).map(v => [v]); // Cal_{t-1}
  const X1 = calDivSeries.slice(0, m).map((v, i) => [v, esrSeries[i]]); // Cal_{t-1}, ESR_{t-1}
  const y = calDivSeries.slice(lag); // Cal_t

  const model0 = fitModel(X0, y);
  const model1 = fitModel(X1, y);
  const deltaR2 = model1.rSquared - model0.rSquared;

  if (deltaR2 > bestDeltaR2) {
    bestDeltaR2 = deltaR2;
    bestLag = lag;
  }
}

// ── Run best model ──
const lag = bestLag;
const m = n - lag;
const X0 = calDivSeries.slice(0, m).map(v => [v]);
const X1 = calDivSeries.slice(0, m).map((v, i) => [v, esrSeries[i]]);
const y = calDivSeries.slice(lag);

const model0 = fitModel(X0, y);
const model1 = fitModel(X1, y);
const deltaR2 = model1.rSquared - model0.rSquared;
const aicDelta = model0.aic - model1.aic; // positive = model1 better (lower AIC)

// ── Interpret ──
let direction, strength;
if (deltaR2 <= 0 || aicDelta <= 0) {
  direction = 'NONE (ESR does not Granger-cause Calibration)';
  strength = 'no_causality';
} else if (deltaR2 > 0.2 || aicDelta > 4) {
  direction = 'ESR → Calibration (ESR predicts calibration divergence)';
  strength = 'strong';
} else if (deltaR2 > 0.05 || aicDelta > 2) {
  direction = 'ESR → Calibration (weak)';
  strength = 'weak';
} else {
  direction = 'ESR → Calibration (borderline)';
  strength = 'borderline';
}

// ── Also test reverse direction: does Cal_{t-1} predict ESR_t? ──
const mRev = n - lag;
const X0Rev = esrSeries.slice(0, mRev).map(v => [v]);
const X1Rev = esrSeries.slice(0, mRev).map((v, i) => [v, calDivSeries[i]]);
const yRev = esrSeries.slice(lag);

const rev0 = fitModel(X0Rev, yRev);
const rev1 = fitModel(X1Rev, yRev);
const revDeltaR2 = rev1.rSquared - rev0.rSquared;
const revAicDelta = rev0.aic - rev1.aic;

let reverseDir = 'NONE';
if (revDeltaR2 > 0.05 && revAicDelta > 2) reverseDir = 'Calibration → ESR (weak)';
else if (revDeltaR2 > 0.2 || revAicDelta > 4) reverseDir = 'Calibration → ESR';

// ── Effective degrees of freedom ──
// Granger with n data points at lag L has n-L-1 effective observations
const effDF = n - lag - 1;
const dfWarning = effDF < 10
  ? `\n  ⚠  WARNING: ${effDF} effective DF is too few for reliable Granger inference. Need ≥10.\n     Results are provisional and may reverse with more data.`
  : '';

// ── Output ──
console.log('\n═══ Granger Causality Test ═══\n');
console.log(`  Data points:       ${n} (eff DF for test: ${effDF})${dfWarning}`);
console.log(`  Optimal lag:       ${lag}`);
console.log(`  ESR range:         [${Math.min(...esrSeries).toFixed(3)}, ${Math.max(...esrSeries).toFixed(3)}]`);
console.log(`  Cal range:         [${Math.min(...calDivSeries).toFixed(3)}, ${Math.max(...calDivSeries).toFixed(3)}]`);

console.log(`\n  ── Forward: ESR → Calibration ──`);
console.log(`  Model 0 R² (Cal only):  ${model0.rSquared.toFixed(4)}`);
console.log(`  Model 1 R² (+ESR):      ${model1.rSquared.toFixed(4)}`);
console.log(`  ΔR²:               ${(deltaR2 * 100).toFixed(2)}%`);
console.log(`  ΔAIC:              ${aicDelta.toFixed(2)} (positive = Model 1 better)`);
console.log(`  Direction:         ${direction}`);

console.log(`\n  ── Reverse: Calibration → ESR ──`);
console.log(`  ΔR²:               ${(revDeltaR2 * 100).toFixed(2)}%`);
console.log(`  ΔAIC:              ${revAicDelta.toFixed(2)}`);
console.log(`  Direction:         ${reverseDir}`);

// ── Combined verdict ──
console.log(`\n  ── Causal Architecture ──`);
let arch;
let archNote = '';
if (effDF < 10) {
  arch = '⚠ INSUFFICIENT DF — any directional claim is unreliable';
  archNote = `  Only ${effDF} effective observations. Need ≥10 for statistical minimum.`;
} else if (strength === 'strong' && revDeltaR2 <= 0) {
  arch = 'UNIDIRECTIONAL (ESR → Cal) — knowledge drives calibration adjustment';
} else if (strength === 'strong' && revDeltaR2 > 0.05) {
  arch = 'BIDIRECTIONAL (ESR ↔ Cal) — feedback loop active';
} else if (strength === 'no_causality' && revDeltaR2 <= 0) {
  arch = 'NULL — no temporal causality in either direction';
} else if (strength === 'no_causality' && revDeltaR2 > 0.05) {
  arch = 'REVERSE ONLY (Cal → ESR) — metrics follow thresholds';
} else {
  arch = 'WEAK/UNCLEAR — insufficient temporal separation';
}
console.log(`  ${arch}`);
if (archNote) console.log(archNote);
console.log('');

// ── Persist ──
const entry = {
  date: new Date().toISOString(), n, lag,
  fwd_deltaR2: +deltaR2.toFixed(4), fwd_aicDelta: +aicDelta.toFixed(2),
  rev_deltaR2: +revDeltaR2.toFixed(4), rev_aicDelta: +revAicDelta.toFixed(2),
  direction, reverseDir, architecture: arch,
  esrSeries, calDivSeries,
};
const prev = db.prepare("SELECT history FROM truth_calibration WHERE metric = 'granger_test'").get();
const hist = prev ? jparse(prev.history) : [];
hist.push(entry);
db.prepare(`INSERT OR REPLACE INTO truth_calibration (metric, current_value, sample_size, last_calibrated, history)
  VALUES ('granger_test', ?, ?, datetime('now'), ?)`)
  .run(deltaR2, n, JSON.stringify(hist));

closeDb();
