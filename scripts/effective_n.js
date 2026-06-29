import { getDb, closeDb } from '../data/db.js';

const db = getDb();

function one(sql) { return db.prepare(sql).get(); }
function all(sql) { return db.prepare(sql).all(); }

// ── Helpers ──
function ar1Metric(values) {
  if (values.length < 2) return values.length;
  let same = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] === values[i - 1]) same++;
  }
  const rho = values.length > 1 ? same / (values.length - 1) : 0;
  return { rho, nEff: values.length * (1 - rho) / (1 + rho) };
}

function simpsonH(counts) {
  const total = Object.values(counts).reduce((s, v) => s + v, 0);
  if (total === 0) return { H: 0, nEff: 0 };
  const h = 1 / Object.values(counts).reduce((s, v) => { const p = v / total; return s + p * p; }, 0);
  return { H: h, nEff: h };
}

// ── Compute all metrics for a given event list ──
function analyze(events, label) {
  const total = events.length;
  if (total < 2) return null;

  const fixTypes = events.map(e => e.fix_type);
  const outcomes = events.map(e => e.outcome);
  const repos = events.map(e => e.repo);

  const ar1FT = ar1Metric(fixTypes);
  const ar1Out = ar1Metric(outcomes);
  const ar1Rep = ar1Metric(repos);

  const ftCounts = {};
  events.forEach(e => { ftCounts[e.fix_type] = (ftCounts[e.fix_type] || 0) + 1; });
  const simFT = simpsonH(ftCounts);

  const repoCounts = {};
  events.forEach(e => { repoCounts[e.repo] = (repoCounts[e.repo] || 0) + 1; });
  const simRepo = simpsonH(repoCounts);

  // Distribution breakdown
  const dist = Object.entries(ftCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `${t}=${c} (${(c / total * 100).toFixed(1)}%)`)
    .join(', ');

  // Conservative bound
  const ests = [ar1FT.nEff, ar1Out.nEff, ar1Rep.nEff, simFT.nEff, simRepo.nEff];
  const cons = Math.min(...ests);

  return {
    total, label,
    ar1FixType: Math.round(ar1FT.nEff * 10) / 10,
    ar1Outcome: Math.round(ar1Out.nEff * 10) / 10,
    ar1Repo: Math.round(ar1Rep.nEff * 10) / 10,
    simpsonFt: Math.round(simFT.H * 10) / 10,
    simpsonRepo: Math.round(simRepo.H * 10) / 10,
    ar1Rho: ar1FT.rho,
    conservative: Math.round(cons * 10) / 10,
    distribution: dist,
    estimates: ests,
  };
}

function printSection(result) {
  if (!result) return;
  console.log(`  ── ${result.label} ──`);
  console.log(`  Raw events:                ${String(result.total).padStart(5)}`);
  console.log(`  Distribution:              ${result.distribution}`);
  console.log(`  AR1 (fix-type):            n_eff = ${String(result.ar1FixType).padStart(5)}  (ρ = ${(result.ar1Rho * 100).toFixed(1)}%)`);
  console.log(`  AR1 (outcome):             n_eff = ${String(result.ar1Outcome).padStart(5)}`);
  console.log(`  Simpson H (fix-type):      n_eff = ${String(result.simpsonFt).padStart(5)}`);
  console.log(`  Simpson H (repo):          n_eff = ${String(result.simpsonRepo).padStart(5)}`);
  console.log(`  Conservative eff_n:        ${String(result.conservative).padStart(5)}`);
  console.log(`  Stats:                     AR1 ρ=${(result.ar1Rho*100).toFixed(0)}%, Simpson H=${result.simpsonFt}, min(ests)=${result.conservative}`);
}

// ── Main ──
function main() {
  const allEvents = all('SELECT fix_type, outcome, repo FROM truth_events ORDER BY id');
  if (allEvents.length === 0) {
    console.log('\n  No events found.\n');
    closeDb();
    return;
  }

  const cumulative = analyze(allEvents, 'Cumulative (all-time)');
  const windowEvents = allEvents.slice(-100);
  const windowed = analyze(windowEvents, `Windowed (last ${windowEvents.length})`);

  const runs = one("SELECT COUNT(*) AS n FROM truth_calibration WHERE metric = 'baseline:v1_snapshot'").n || 0;
  const rc = one("SELECT current_value FROM truth_calibration WHERE metric = 'run_counter'");
  const runCounterVal = rc ? rc.current_value : 0;
  const uniqueInt = allEvents.reduce((s, e) => s.add(e.fix_type), new Set()).size;

  console.log('');
  console.log('═══ Effective Sample Size Analysis ═══');
  console.log('');

  printSection(cumulative);
  console.log('');
  printSection(windowed);

  // Operational recommendation
  const opN = windowed ? Math.min(windowed.ar1FixType, windowed.simpsonFt) : cumulative.ar1FixType;
  const opSource = windowed ? 'windowed min(AR1, Simpson)' : 'cumulative AR1';

  console.log('');
  console.log(`  ${'='.repeat(50)}`);
  console.log(`  OPERATIONAL Effective n:     ${String(Math.round(opN)).padStart(5)}  (${opSource})`);
  console.log(`  ${'='.repeat(50)}`);
  console.log(`  Structural info:             ${runs} runs, ${runCounterVal} via counter, ${uniqueInt} fix types`);
  console.log('');

  // Honest assessment
  console.log(`  Current state:`);
  console.log(`    Raw n = ${allEvents.length}, eff_n = ${Math.round(opN)} → ${(opN / allEvents.length * 100).toFixed(0)}% info efficiency`);
  console.log(`    System generates ${((1 - opN / allEvents.length) * 100).toFixed(0)}% redundant events (same info, different label)`);
  console.log('');

  if (opN < 50) {
    console.log(`  🔴 Effective n below 50 — system not yet generating diverse info`);
    console.log(`     Need: more minority fix-types (dependency ${cumulative.distribution.match(/dependency=\d+/)?.[0]?.split('=')?.[1] || 0}, ci_failure ${cumulative.distribution.match(/ci_failure=\d+/)?.[0]?.split('=')?.[1] || 0})`);
    console.log(`     Tool: node scripts/run_real_pilot.js continues adaptive targeting`);
  } else if (opN < 100) {
    console.log(`  🟡 Effective n adequate — Granger may produce tentative results`);
    console.log(`     Target 100+ for stable causal inference`);
  } else {
    console.log(`  🟢 Effective n sufficient — statistical tests have adequate power`);
  }
  console.log('');

  closeDb();
}

main();
