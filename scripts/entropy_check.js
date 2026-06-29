import { getDb, closeDb } from '../data/db.js';

const db = getDb();

// ── Current state queries ──
function getState() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM truth_events').get().n;
  if (total === 0) return null;

  // Fix type distribution
  const types = db.prepare('SELECT fix_type, COUNT(*) AS n FROM truth_events GROUP BY fix_type ORDER BY n DESC').all();
  const total2 = types.reduce((s, t) => s + t.n, 0);
  const pcts = types.map(t => ({ ...t, pct: t.n / total2 }));

  // Simpson entropy: H = 1 - sum(p_i^2)
  const H = 1 - pcts.reduce((s, t) => s + t.pct * t.pct, 0);

  // Repo diversity
  const repos = db.prepare('SELECT COUNT(DISTINCT repo) AS n FROM truth_events').get().n;

  // Outcome distribution
  const outcomes = db.prepare('SELECT outcome, COUNT(*) AS n FROM truth_events GROUP BY outcome').all();
  const outTotal = outcomes.reduce((s, o) => s + o.n, 0);
  const outPcts = outcomes.map(o => ({ ...o, pct: o.n / outTotal }));
  const outH = 1 - outPcts.reduce((s, o) => s + o.pct * o.pct, 0);

  // Pattern diversity
  const pats = db.prepare('SELECT fix_type, SUM(times_used) AS total FROM patterns WHERE times_used > 0 GROUP BY fix_type ORDER BY total DESC').all();
  const patTotal = pats.reduce((s, p) => s + p.total, 0);
  const patPcts = pats.map(p => ({ ...p, pct: p.total / patTotal }));
  const patH = patTotal > 0 ? 1 - patPcts.reduce((s, p) => s + p.pct * p.pct, 0) : 0;

  // Outcome asymmetry
  const merged = outcomes.find(o => o.outcome === 'merged');
  const closed = outcomes.find(o => o.outcome === 'closed');
  const mergedN = merged ? merged.n : 0;
  const closedN = closed ? closed.n : 0;
  const mergeRate = total > 0 ? mergedN / total : 0;

  return { total, H, repos, outH, patH, mergedN, closedN, mergeRate, pcts, outPcts };
}

// ── Read stored snapshot (last run state) ──
const snapshotRow = db.prepare("SELECT history FROM truth_calibration WHERE metric = 'entropy_snapshot'").get();
const prevState = snapshotRow ? JSON.parse(snapshotRow.history) : null;
const currState = getState();

if (!currState) {
  console.log('\n═══ Entropy Injection Check ═══\n');
  console.log('  No truth events yet.', '\n');
  process.exit(0);
}

// ── Compute deltas ──
console.log('\n═══ Entropy Injection Check ═══\n');
console.log(`  Events:          ${currState.total}`);
console.log(`  Fix types:       ${currState.pcts.map(p => `${p.fix_type}=${(p.pct*100).toFixed(1)}%`).join(', ')}`);
console.log(`  Simpson H:       ${currState.H.toFixed(4)} (0 = single type, 1 = max diversity)`);
console.log(`  Repos:           ${currState.repos}`);
console.log(`  Outcome H:       ${currState.outH.toFixed(4)} (0 = all same, 1 = balanced)`);
console.log(`  Pattern H:       ${currState.patH.toFixed(4)}`);
console.log(`  Merge rate:      ${(currState.mergeRate * 100).toFixed(1)}%`);

if (prevState) {
  console.log('\n  ── Since last run ──');
  const dH = currState.H - prevState.H;
  const dRepos = currState.repos - prevState.repos;
  const dOutH = currState.outH - prevState.outH;
  const dPatH = currState.patH - prevState.patH;

  const novel = [];
  if (dH > 0.01) novel.push('fix-type entropy');
  if (dRepos > 0) novel.push(`${dRepos} new repo(s)`);
  if (dOutH > 0.01) novel.push('outcome diversity');
  if (dPatH > 0.01) novel.push('pattern diversity');

  console.log(`  Δ Simpson H:     ${dH > 0 ? '+' : ''}${dH.toFixed(4)}`);
  console.log(`  Δ Repos:         ${dRepos > 0 ? '+' : ''}${dRepos}`);
  console.log(`  Δ Outcome H:     ${dOutH > 0 ? '+' : ''}${dOutH.toFixed(4)}`);
  console.log(`  Δ Pattern H:     ${dPatH > 0 ? '+' : ''}${dPatH.toFixed(4)}`);

  if (novel.length > 0) {
    console.log(`\n  ✅ Novel injection: ${novel.join(', ')}`);
    console.log(`  Run added informational entropy.`);
  } else {
    console.log(`\n  ⚠️  No measurable entropy change.`);
    console.log(`  Run was statistically redundant.`);
    console.log(`  All increases are within noise (Δ < 0.01).`);
  }
}
// ── Interpretation ──
console.log(`\n  ── Diversity status ──`);
const checks = [];
if (currState.H >= 0.3) checks.push('fix-type diversity met');
else checks.push(`fix-type diversity low (H=${currState.H.toFixed(3)}/0.3)`);
if (currState.patH >= 0.3) checks.push('pattern diversity met');
else checks.push(`pattern diversity low (H=${currState.patH.toFixed(3)}/0.3)`);
if (currState.outH > 0.1) checks.push('outcome asymmetry present');
else checks.push('outcome asymmetry missing (all events same outcome)');
for (const c of checks) console.log(`  ${c.startsWith('fix-type diversity met') || c.startsWith('pattern diversity met') || c.startsWith('outcome asymmetry present') ? '✅' : '  '} ${c}`);

// ── Verdict ──
console.log(`\n  ── Verdict ──`);
if (currState.H < 0.1) console.log('  🔴 Single-mode lock. Entropy injection is the priority, not more runs.');
else if (currState.H < 0.3) console.log('  🟡 Low entropy. System needs diverse fix types, not volume.');
else if (currState.patH < 0.3) console.log('  🟡 Pattern diversity below threshold — knowledge layer is concentrated.');
else console.log('  🟢 Entropy adequate. Focus on volume to reduce noise.');
console.log('');

// ── Persist for next comparison ──
db.prepare(`INSERT OR REPLACE INTO truth_calibration (metric, current_value, sample_size, last_calibrated, history)
  VALUES ('entropy_snapshot', ?, 1, datetime('now'), ?)`)
  .run(currState.H, JSON.stringify(currState));

closeDb();
