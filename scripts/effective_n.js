import { getDb, closeDb } from '../data/db.js';

const db = getDb();

function one(sql) { return db.prepare(sql).get(); }
function all(sql) { return db.prepare(sql).all(); }

// ── Effective Sample Size Estimates ──

// 1. AR1 autocorrelation: n_eff = n * (1 - ρ) / (1 + ρ)
// ρ = proportion of consecutive events with same fix_type
function ar1EffectiveN(events) {
  if (events.length < 2) return events.length;
  let same = 0;
  for (let i = 1; i < events.length; i++) {
    if (events[i] === events[i - 1]) same++;
  }
  const rho = same / (events.length - 1);
  return events.length * (1 - rho) / (1 + rho);
}

// 2. Simpson reciprocal: effective categories = 1 / Σ(pᵢ²)
// Measures how many independent categories the data spans
function simpsonEffectiveN(counts) {
  const total = counts.reduce((s, c) => s + c, 0);
  if (total === 0) return 0;
  const H = counts.reduce((s, c) => { const p = c / total; return s + p * p; }, 0);
  return total * (1 / H) / total * 1; // normalize: proportion of simpson diversity
}

// 3. Conservative bound: minimum of all estimates
function conservativeEffectiveN(estimates) {
  return Math.min(...estimates.filter(e => e > 0));
}

// ── Run ──
function main() {
  const total = one('SELECT COUNT(*) AS n FROM truth_events').n || 0;
  const events = all('SELECT fix_type, outcome, repo FROM truth_events ORDER BY id');

  if (total === 0) {
    console.log('\n  No events found. Run run_real_pilot.js first.\n');
    closeDb();
    return;
  }

  // AR1 on fix_type sequence
  const fixTypes = events.map(e => e.fix_type);
  const nAR1 = ar1EffectiveN(fixTypes);

  // AR1 on outcome sequence (merged/closed/reopened)
  const outcomes = events.map(e => e.outcome);
  const nOutcome = ar1EffectiveN(outcomes);

  // AR1 on repo sequence (same repo = same project context)
  const repos = events.map(e => e.repo);
  const nRepo = ar1EffectiveN(repos);

  // Simpson diversity: fix_type
  const ftCounts = {};
  events.forEach(e => { ftCounts[e.fix_type] = (ftCounts[e.fix_type] || 0) + 1; });
  const ftSimpson = 1 / Object.values(ftCounts).reduce((s, c) => { const p = c / total; return s + p * p; }, 0);
  const effFtTypes = total * (ftSimpson / Object.keys(ftCounts).length); // scaled

  // Simpson diversity: repo
  const repoCounts = {};
  events.forEach(e => { repoCounts[e.repo] = (repoCounts[e.repo] || 0) + 1; });
  const repoSimpson = 1 / Object.values(repoCounts).reduce((s, c) => { const p = c / total; return s + p * p; }, 0);

  // Run count from baseline history
  const snap = one("SELECT history FROM truth_calibration WHERE metric = 'baseline:v1_snapshot'");
  let runs = 0;
  let uniqueInterventions = 0;
  if (snap) {
    const h = JSON.parse(snap.history || '[]');
    runs = h.length;
    uniqueInterventions = new Set(h.filter(r => r.intervention).map(r => r.intervention)).size;
  }

  // Count run_counter values
  const rc = one("SELECT current_value FROM truth_calibration WHERE metric = 'run_counter'");
  const runCounterVal = rc ? rc.current_value : 0;

  // ── Consolidated Estimates ──
  const runBased = runCounterVal > 0 ? total / runCounterVal : total;   // events per unique run
  const profileBased = uniqueInterventions > 0 ? total / uniqueInterventions : total;

  const estimates = {
    raw_n: total,
    ar1_fix_type: Math.round(nAR1 * 10) / 10,
    ar1_outcome: Math.round(nOutcome * 10) / 10,
    ar1_repo: Math.round(nRepo * 10) / 10,
    simpson_fix_type: Math.round(ftSimpson * 10) / 10,
    simpson_repo: Math.round(repoSimpson * 10) / 10,
    run_based: Math.round(runBased * 10) / 10,
    profile_based: Math.round(profileBased * 10) / 10,
  };

  const conservative = Math.min(
    nAR1, nOutcome, nRepo,
    ftSimpson, repoSimpson,
    runBased, profileBased,
    total
  );

  console.log('');
  console.log('═══ Effective Sample Size Analysis ═══');
  console.log('');
  console.log(`  Raw events:                ${String(total).padStart(5)}`);
  console.log(`  ── Autocorrelation (AR1) ──`);
  console.log(`  Fix-type persistence:      ${String(estimates.ar1_fix_type).padStart(5)}  (${(nAR1/total*100).toFixed(0)}% of raw)`);
  console.log(`  Outcome persistence:       ${String(estimates.ar1_outcome).padStart(5)}  (${(nOutcome/total*100).toFixed(0)}% of raw)`);
  console.log(`  Repo persistence:          ${String(estimates.ar1_repo).padStart(5)}  (${(nRepo/total*100).toFixed(0)}% of raw)`);
  console.log(`  ── Diversity (Simpson reciprocal) ──`);
  console.log(`  Fix-type diversity:        ${String(estimates.simpson_fix_type).padStart(5)}  (~${Object.keys(ftCounts).length} types)`);
  console.log(`  Repo diversity:            ${String(estimates.simpson_repo).padStart(5)}  (~${Object.keys(repoCounts).length} repos)`);
  console.log(`  ── Structural ──`);
  console.log(`  Independent runs:          ${String(runs).padStart(5)}  (${runCounterVal} via counter)`);
  console.log(`  Unique intervention types: ${String(uniqueInterventions).padStart(5)}`);
  console.log(`  Events per run:            ${String(Math.round(total / Math.max(runs, 1))).padStart(5)}`);
  console.log(`  Events per profile:        ${String(Math.round(total / Math.max(uniqueInterventions, 1))).padStart(5)}`);
  console.log('');
  console.log(`  ── Conservative effective n ──`);
  console.log(`  ${'≈'.repeat(40)}`);
  console.log(`  Effective n (minimum):     ${String(Math.round(conservative)).padStart(5)}`);
  console.log(`  Degrees of freedom loss:   ${(100 - conservative / total * 100).toFixed(0)}%`);
  console.log(`  ${'≈'.repeat(40)}`);
  console.log('');
  console.log('  ⚠  Granger causality needs ≥10 independent data points.');
  console.log(`     With ${runs} runs (${Math.round(conservative)} effective n), statistical tests are:`);
  if (conservative < 10) {
    console.log('     🔴 UNDER POWERED — do not trust directional conclusions');
  } else if (conservative < 20) {
    console.log('     🟡 WEAK — conclusions are provisional');
  } else {
    console.log('     🟢 ADEQUATE — conclusions have statistical support');
  }
  console.log('');
  console.log('  📐 n_eff = min(AR1_fix, AR1_outcome, AR1_repo, Simpson_ft, Simpson_repo, run_based, profile_based)');
  console.log(`     = min(${[nAR1, nOutcome, nRepo, ftSimpson, repoSimpson, runBased, profileBased].map(v => v.toFixed(1)).join(', ')})`);
  console.log(`     = ${conservative.toFixed(1)}`);
  console.log('');

  closeDb();
}

main();
