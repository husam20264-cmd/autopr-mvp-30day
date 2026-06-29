import { getDb, closeDb } from '../data/db.js';

const db = getDb();

// ── Helpers ──
function one(sql, p = {}) { return db.prepare(sql).get(p); }
function all(sql, p = {}) { return db.prepare(sql).all(p); }

// ── Effective n from fix-type autocorrelation ──
function ar1EffectiveN(events) {
  if (events.length < 2) return events.length;
  let same = 0;
  for (let i = 1; i < events.length; i++) {
    if (events[i] === events[i - 1]) same++;
  }
  const rho = same / (events.length - 1);
  return events.length * (1 - rho) / (1 + rho);
}

function computeEffectiveN(repoList) {
  if (repoList.length === 0) return 0;
  const placeholders = repoList.map(() => '?').join(',');
  const rows = all(`SELECT fix_type FROM truth_events WHERE repo IN (${placeholders}) ORDER BY id`, repoList);
  if (rows.length === 0) return 0;
  return Math.round(ar1EffectiveN(rows.map(r => r.fix_type)) * 10) / 10;
}

// ── Check repos table for split column ──
const colCheck = db.prepare("PRAGMA table_info(repos)").all();
if (!colCheck.find(c => c.name === 'split')) {
  console.log('No split column in repos. Add it to schema.sqlite and recreate DB.');
  process.exit(0);
}

// ── Count by split ──
const repos = all('SELECT full_name, split FROM repos');
const trainRepos = repos.filter(r => r.split === 'train').map(r => r.full_name);
const evalRepos = repos.filter(r => r.split === 'eval').map(r => r.full_name);

if (evalRepos.length === 0) {
  console.log('\n═══ Generalization Check ═══\n');
  console.log('  No eval repos assigned. Run pilot with split logic active.\n');
  process.exit(0);
}

// ── Event stats by split ──
function splitStats(repoList) {
  if (repoList.length === 0) return null;
  const placeholders = repoList.map(() => '?').join(',');
  const total = one(`SELECT COUNT(*) AS n FROM truth_events WHERE repo IN (${placeholders})`, repoList).n;
  if (total === 0) return { total: 0, merged: 0, closed: 0, accuracy: 0, patternEvents: 0, patternRate: 0 };
  const merged = one(`SELECT COUNT(*) AS n FROM truth_events WHERE repo IN (${placeholders}) AND outcome='merged'`, repoList).n;
  const accuracy = merged / total;

  // Pattern usage: events that match a pattern's repo list
  const patterns = all('SELECT repos FROM patterns');
  let patternEvents = 0;
  for (const event of all(`SELECT repo, outcome FROM truth_events WHERE repo IN (${placeholders})`, repoList)) {
    for (const p of patterns) {
      const prepos = JSON.parse(p.repos || '[]');
      if (prepos.includes(event.repo)) { patternEvents++; break; }
    }
  }

  return {
    total,
    merged,
    closed: total - merged,
    accuracy: +accuracy.toFixed(4),
    patternEvents,
    patternRate: total > 0 ? +(patternEvents / total).toFixed(4) : 0,
  };
}

const train = splitStats(trainRepos);
const eval_ = splitStats(evalRepos);

// ── Generalization gap ──
const gap = train && eval_ && train.total > 0 && eval_.total > 0
  ? Math.abs(train.accuracy - eval_.accuracy)
  : null;

// ── Generalization rate: pattern hits on eval repos ──
const genRate = eval_ && eval_.total > 0
  ? eval_.patternEvents / eval_.total
  : 0;

// ── Output ──
console.log('\n═══ Generalization Check (External Reward Signal) ═══\n');
console.log(`  Repos: ${trainRepos.length} train, ${evalRepos.length} eval`);

const trainEffN = computeEffectiveN(trainRepos);
const evalEffN = computeEffectiveN(evalRepos);

console.log(`\n  ── Training set ──`);
if (train) {
  console.log(`  Events:     ${train.total} (eff n: ${trainEffN})`);
  console.log(`  Accuracy:   ${(train.accuracy * 100).toFixed(1)}%`);
  console.log(`  Pattern:    ${train.patternEvents}/${train.total} (${(train.patternRate * 100).toFixed(1)}%)`);
}

console.log(`\n  ── Evaluation set (held-out) ──`);
if (eval_) {
  console.log(`  Events:     ${eval_.total} (eff n: ${evalEffN})`);
  console.log(`  Accuracy:   ${(eval_.accuracy * 100).toFixed(1)}%`);
  console.log(`  Pattern:    ${eval_.patternEvents}/${eval_.total} (${(eval_.patternRate * 100).toFixed(1)}%)`);
}

let verdict = 'INSUFFICIENT DATA';
console.log(`\n  ── Generalization ──`);
if (gap !== null) {
  console.log(`  Accuracy gap (|train - eval|):  ${(gap * 100).toFixed(1)}%`);
  console.log(`  Eval pattern hit rate:         ${(genRate * 100).toFixed(1)}%`);
  if (evalEffN < 5) {
    verdict = `LOW EFFECTIVE N — eval data is ${evalEffN} independent obs (need ≥5)`;
  } else if (trainEffN < 10) {
    verdict = `LOW EFFECTIVE N — train data is ${trainEffN} independent obs (need ≥10)`;
  } else if (eval_.total < 3) {
    verdict = 'INSUFFICIENT EVAL DATA (need ≥3 eval events)';
  } else if (train.total < 10) {
    verdict = 'INSUFFICIENT TRAIN DATA';
  } else if (gap < 0.1 && genRate > 0.2) {
    verdict = 'GENERALIZATION CONFIRMED — patterns transfer to held-out repos';
  } else if (gap > 0.3) {
    verdict = 'OVERFITTING — train accuracy >> eval accuracy. System memorizes, not learns.';
  } else if (genRate === 0 && train.patternRate > 0.3) {
    verdict = 'MEMORIZATION — patterns active only on training repos';
  } else if (gap < 0.2) {
    verdict = 'WEAK GENERALIZATION — gap small but eval pattern rate low';
  } else {
    verdict = 'INCONCLUSIVE — more data needed on both splits';
  }
  console.log(`  ${verdict}`);
}

// ── Persist as external reward signal ──
const entry = {
  date: new Date().toISOString(),
  train: train ? { total: train.total, accuracy: train.accuracy, patternRate: train.patternRate } : null,
  eval: eval_ ? { total: eval_.total, accuracy: eval_.accuracy, patternRate: eval_.patternRate } : null,
  gap: gap !== null ? +gap.toFixed(4) : null,
  genRate: +genRate.toFixed(4),
  verdict: verdict || 'INSUFFICIENT DATA',
};
const prev = db.prepare("SELECT history FROM truth_calibration WHERE metric = 'generalization'").get();
const hist = prev ? JSON.parse(prev.history) : [];
hist.push(entry);
db.prepare(`INSERT OR REPLACE INTO truth_calibration (metric, current_value, sample_size, last_calibrated, history)
  VALUES ('generalization', ?, ?, datetime('now'), ?)`)
  .run(genRate, eval_ ? eval_.total : 0, JSON.stringify(hist));

console.log('');
closeDb();
