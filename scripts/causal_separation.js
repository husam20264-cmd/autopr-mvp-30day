import { getDb, closeDb } from '../data/db.js';

const db = getDb();

function jparse(s) { try { return JSON.parse(s); } catch { return []; } }

// ── Load ESR history ──
const esrRow = db.prepare("SELECT history, sample_size FROM truth_calibration WHERE metric = 'esr_score'").get();
if (!esrRow || esrRow.sample_size < 2) {
  console.log('\n═══ Causal Separation Test ═══\n');
  console.log('  Need ≥2 ESR data points to test independence.\n');
  process.exit(0);
}

const esrHistory = jparse(esrRow.history);
const n = esrHistory.length;

// ── For each ESR point, reconstruct the fix-type distribution at that time ──
// Use truth_events created_at before each ESR point's date
const snapshots = [];
for (const point of esrHistory) {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM truth_events WHERE created_at <= ?`).get(point.date).n;
  const types = db.prepare(`
    SELECT fix_type, COUNT(*) AS n FROM truth_events WHERE created_at <= ?
    GROUP BY fix_type ORDER BY n DESC
  `).all(point.date);

  const dist = {};
  for (const t of types) dist[t.fix_type] = t.n / total;

  snapshots.push({
    date: point.date,
    esr: point.score,
    total,
    dist,
    // Simpson H for this snapshot
    H: 1 - Object.values(dist).reduce((s, p) => s + p * p, 0),
    // Number of fix types with ≥5% share
    activeTypes: Object.entries(dist).filter(([_, p]) => p >= 0.05).length,
  });
}

// ── Test 1: Does ESR track fix-type distribution? ──
// If R² between dist-similarity and ESR-change is high → ESR is just a weighted average
let esrChanges = [];
let distChanges = [];
for (let i = 1; i < snapshots.length; i++) {
  const prev = snapshots[i - 1];
  const curr = snapshots[i];
  const dESR = curr.esr - prev.esr;

  // Distribution similarity: sum of min(p_prev, p_curr) across shared types
  const allTypes = [...new Set([...Object.keys(prev.dist), ...Object.keys(curr.dist)])];
  let similarity = 0;
  for (const t of allTypes) {
    similarity += Math.min(prev.dist[t] || 0, curr.dist[t] || 0);
  }
  // Also track distribution shift as 1 - similarity
  const dDist = 1 - similarity;

  esrChanges.push(dESR);
  distChanges.push(dDist);
}

// R² between ΔESR and ΔDist
const m = esrChanges.length;
if (m >= 2) {
  const meanESR = esrChanges.reduce((s, v) => s + v, 0) / m;
  const meanDist = distChanges.reduce((s, v) => s + v, 0) / m;
  const num = esrChanges.reduce((s, e, i) => s + (e - meanESR) * (distChanges[i] - meanDist), 0);
  const den = Math.sqrt(
    esrChanges.reduce((s, e) => s + Math.pow(e - meanESR, 2), 0) *
    distChanges.reduce((s, d) => s + Math.pow(d - meanDist, 2), 0)
  );
  const r = den > 0 ? num / den : 0;
  const rSquared_dist = r * r;

  // ── Test 2: Does ESR track Simpson H? ──
  const hChanges = [];
  for (let i = 1; i < snapshots.length; i++) {
    hChanges.push(snapshots[i].H - snapshots[i - 1].H);
  }
  const meanH = hChanges.reduce((s, v) => s + v, 0) / m;
  const numH = esrChanges.reduce((s, e, i) => s + (e - meanESR) * (hChanges[i] - meanH), 0);
  const denH = Math.sqrt(
    esrChanges.reduce((s, e) => s + Math.pow(e - meanESR, 2), 0) *
    hChanges.reduce((s, h) => s + Math.pow(h - meanH, 2), 0)
  );
  const rH = denH > 0 ? numH / denH : 0;
  const rSquared_H = rH * rH;

  // ── Output ──
  console.log('\n═══ Causal Separation Test ═══\n');

  console.log('  Snapshot history:');
  console.log('  #   date          esr     H      types  events');
  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    const types = Object.entries(s.dist)
      .filter(([_, p]) => p >= 0.05)
      .map(([t, p]) => `${t.slice(0, 8)} ${(p * 100).toFixed(0)}%`)
      .join(', ');
    console.log(`  ${i + 1}   ${s.date.slice(5, 16)}  ${s.esr.toFixed(3)}  ${s.H.toFixed(3)}  ${types.slice(0, 30)}  ${s.total}`);
  }

  console.log(`\n  ── Independence tests ──`);
  console.log(`  ΔESR vs ΔDistribution:  R² = ${rSquared_dist.toFixed(4)}`);
  console.log(`  ΔESR vs ΔSimpson H:     R² = ${rSquared_H.toFixed(4)}`);

  let verdict;
  if (m < 3) {
    verdict = 'INSUFFICIENT TRANSITIONS (need 3+ Δ points)';
  } else if (rSquared_dist > 0.7) {
    verdict = 'ESR IS A WEIGHTED AVERAGE — moves only when distribution changes';
  } else if (rSquared_dist > 0.4) {
    verdict = 'ESR IS PARTIALLY COUPLED — some independence, but distribution dominates';
  } else if (rSquared_H > rSquared_dist) {
    verdict = 'ESR TRACKS ENTROPY MORE THAN RAW DISTRIBUTION — signal-like behavior';
  } else {
    verdict = 'ESR IS PARTIALLY INDEPENDENT — regime separation candidate';
  }

  console.log(`\n  ── Verdict ──`);
  console.log(`  ${verdict}`);
  console.log('');

  // ── Persist ──
  const entry = { date: new Date().toISOString(), n, rSquared_dist, rSquared_H, verdict };
  const prev = db.prepare("SELECT history FROM truth_calibration WHERE metric = 'causal_separation'").get();
  const hist = prev ? jparse(prev.history) : [];
  hist.push(entry);
  db.prepare(`INSERT OR REPLACE INTO truth_calibration (metric, current_value, sample_size, last_calibrated, history)
    VALUES ('causal_separation', ?, ?, datetime('now'), ?)`)
    .run(rSquared_dist, n, JSON.stringify(hist));

} else {
  console.log('\n═══ Causal Separation Test ═══\n');
  console.log('  Need ≥2 transitions between ESR snapshots.\n');
}

closeDb();
