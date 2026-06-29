import { getDb, closeDb } from '../data/db.js';

const db = getDb();

function one(sql, params = {}) { return db.prepare(sql).get(params); }
function all(sql, params = {}) { return db.prepare(sql).all(params); }

function green(msg) { return `  ✅ ${msg}`; }
function red(msg)   { return `  ❌ ${msg}`; }
function gray(msg)  { return `  ⚪ ${msg}`; }

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

// ── 1. TRUTH LAYER STABILITY ─────────────────────────────
function checkTruthLayer() {
  console.log('\n── 1. TRUTH LAYER STABILITY ──');

  const total    = one(`SELECT COUNT(*) AS n FROM truth_events`).n;
  const repos    = one(`SELECT COUNT(DISTINCT repo) AS n FROM truth_events`).n;
  const runDays  = one(`SELECT COUNT(DISTINCT DATE(created_at)) AS n FROM truth_events`).n;
  const merged   = one(`SELECT COUNT(*) AS n FROM truth_events WHERE outcome = 'merged'`).n;
  const closed   = one(`SELECT COUNT(*) AS n FROM truth_events WHERE outcome = 'closed'`).n;
  const mergePct = total > 0 ? Math.round(100 * merged / total) : 0;

  // Effective n via fix-type autocorrelation (all-time for stability)
  const fixTypes = all(`SELECT fix_type FROM truth_events ORDER BY id`).map(r => r.fix_type);
  const nEff = total > 0 ? Math.round(ar1EffectiveN(fixTypes)) : 0;

  const topRepo  = one(`
    SELECT repo, ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM truth_events), 1) AS pct
    FROM truth_events GROUP BY repo ORDER BY COUNT(*) DESC LIMIT 1
  `);
  const topPct   = topRepo ? +topRepo.pct : 0;

  console.log(total >= 150 ? green(`Truth events: ${total}`)   : red(`Truth events: ${total}/150`));
  console.log(nEff >= 50   ? green(`Effective n (AR1): ${nEff}`): red(`Effective n (AR1): ${nEff}/50 — fix types too autocorrelated`));
  console.log(repos >= 5   ? green(`Distinct repos: ${repos}`)  : red(`Distinct repos: ${repos}/5`));
  console.log(runDays >= 2 ? green(`Time windows: ${runDays}`)  : red(`Time windows: ${runDays}/2`));
  console.log(gray(`Merge rate: ${mergePct}% (${merged} merged / ${closed} closed) — variance check needs 2+ independent runs`));
  console.log(topPct <= 40 ? green(`Top repo dominance: ${topPct}%`) : red(`Top repo dominance: ${topPct}% (>40%)`));

  return total >= 150 && nEff >= 50 && repos >= 5 && runDays >= 2 && topPct <= 40;
}

// ── 2. LEARNING SIGNAL STABILITY ─────────────────────────
function checkLearningSignal() {
  console.log('\n── 2. LEARNING SIGNAL STABILITY ──');

  const patApps  = one(`SELECT COALESCE(SUM(times_used), 0) AS n FROM patterns`).n;
  const reusable = one(`SELECT COUNT(*) AS n FROM patterns WHERE times_used > 0`).n;
  const allPRs   = one(`SELECT COUNT(*) AS n FROM truth_events`).n;
  const reusePRs = one(`SELECT COALESCE(SUM(times_accepted), 0) AS n FROM patterns`).n;
  const reusePct = allPRs > 0 ? Math.round(100 * reusePRs / allPRs) : 0;

  // patterns reused across >=3 repos
  const patterns = all(`SELECT repos FROM patterns`);
  let cross3 = 0;
  for (const p of patterns) {
    const r = JSON.parse(p.repos || '[]');
    if (r.length >= 3) cross3++;
  }

  console.log(patApps >= 100 ? green(`Total pattern applications: ${patApps}`)    : red(`Total pattern applications: ${patApps}/100`));
  console.log(gray(`Reusable patterns (used>0): ${reusable}/${all(`SELECT COUNT(*) AS n FROM patterns`).n}`));
  console.log(reusePct >= 30 ? green(`Reuse rate: ${reusePct}%`)                   : red(`Reuse rate: ${reusePct}%/30%`));
  console.log(cross3 >= 3    ? green(`Patterns across >=3 repos: ${cross3}`)       : red(`Patterns across >=3 repos: ${cross3}/3`));

  return patApps >= 100 && reusePct >= 30 && cross3 >= 3;
}

// ── 3. LLM DEPENDENCY REDUCTION ──────────────────────────
function checkLLMReduction() {
  console.log('\n── 3. LLM DEPENDENCY REDUCTION ──');

  const total  = one(`SELECT COUNT(*) AS n FROM truth_events`).n;
  const patApps = one(`SELECT COALESCE(SUM(times_used), 0) AS n FROM patterns`).n;
  const llmPRs  = total;  // every truth event had LLM involvement in this system
  const llmPerPR = total > 0 ? Math.round(10 * llmPRs / total) / 10 : 0;

  // knowledge reuse rate = pattern applications / total events
  const reusePct = total > 0 ? Math.round(100 * patApps / total) : 0;

  console.log(gray(`LLM calls/PR: ${llmPerPR} (trend needs multiple runs for comparison)`));
  console.log(reusePct >= 25 ? green(`Knowledge reuse rate: ${reusePct}%`) : red(`Knowledge reuse rate: ${reusePct}%/25%`));

  return reusePct >= 25;
}

// ── 4. CALIBRATION VALIDITY ──────────────────────────────
function checkCalibration() {
  console.log('\n── 4. CALIBRATION VALIDITY ──');

  const updates   = one(`SELECT COUNT(*) AS n FROM truth_calibration`).n;
  const adjusted  = one(`SELECT COUNT(*) AS n FROM truth_calibration WHERE sample_size > 1`).n;
  const thresholdCount = one(`SELECT COUNT(DISTINCT metric) AS n FROM truth_calibration`).n;

  console.log(updates >= 10      ? green(`Calibration rows: ${updates}`)     : red(`Calibration rows: ${updates}/10`));
  console.log(adjusted >= 3      ? green(`Metrics adjusted >1×: ${adjusted}`) : red(`Metrics adjusted >1×: ${adjusted}/3`));
  console.log(thresholdCount > 0 ? green(`Distinct thresholds: ${thresholdCount}`) : red('No thresholds'));

  // Check policy re-adjustments
  const reAdjust = all(`SELECT history FROM truth_calibration`);
  let doubleAdj = 0;
  for (const r of reAdjust) {
    try {
      const h = JSON.parse(r.history);
      if (Array.isArray(h) && h.length >= 2) doubleAdj++;
    } catch { /* skip */ }
  }
  console.log(doubleAdj >= 1 ? green(`Metrics with ≥2 adjustments: ${doubleAdj}`) : red(`Metrics with ≥2 adjustments: ${doubleAdj}/1`));

  return updates >= 10;
}

// ── 5. POLICY LAYER MATURITY ─────────────────────────────
function checkPolicyMaturity() {
  console.log('\n── 5. POLICY LAYER MATURITY ──');

  const active  = one(`SELECT COUNT(*) AS n FROM meta_policies WHERE active = 1`).n;
  const totalP  = one(`SELECT COUNT(*) AS n FROM meta_policies`).n;

  // Multi-repo policies: check patterns linked to policies span multiple repos
  const singleRepoPolicies = one(`SELECT COUNT(*) AS n FROM meta_policies WHERE repos_observed <= 1`).n;
  const multiRepoPolicies  = active - singleRepoPolicies;
  console.log(active >= 3    ? green(`Active policies: ${active}/${totalP}`) : red(`Active policies: ${active}/3`));
  console.log(multiRepoPolicies >= 1 ? green(`Multi-repo policies: ${multiRepoPolicies}`) : red(`Multi-repo policies: ${multiRepoPolicies}/1`));

  return active >= 3 && multiRepoPolicies >= 1;
}

// ── 6. FAILURE DIVERSITY ─────────────────────────────────
function checkFailureDiversity() {
  console.log('\n── 6. FAILURE DIVERSITY ──');

  const types = all(`SELECT DISTINCT fix_type AS t FROM truth_events`).map(r => r.t);
  console.log(types.includes('trivial_bug') ? green('trivial_bug present') : red('no trivial_bug'));
  console.log(types.includes('lint')        ? green('lint present')        : red('no lint'));
  console.log(types.includes('dependency')  ? green('dependency present')  : red('no dependency'));

  // merged + closed per type
  for (const t of types) {
    const m = one(`SELECT COUNT(*) AS n FROM truth_events WHERE fix_type = ? AND outcome = 'merged'`, t).n;
    const c = one(`SELECT COUNT(*) AS n FROM truth_events WHERE fix_type = ? AND outcome = 'closed'`, t).n;
    console.log(gray(`  ${t}: ${m} merged, ${c} closed`));
  }

  return types.includes('trivial_bug') && types.includes('lint') && types.includes('dependency');
}

// ── 7. TEMPORAL SIGNAL ───────────────────────────────────
function checkTemporal() {
  console.log('\n── 7. TEMPORAL SIGNAL ──');

  const days = one(`SELECT COUNT(DISTINCT DATE(created_at)) AS n FROM truth_events`).n;
  const runs = one(`SELECT COUNT(*) AS n FROM truth_calibration WHERE metric = 'baseline:v1_snapshot'`).n;

  console.log(days >= 5 ? green(`Days with data: ${days}`) : red(`Days with data: ${days}/5`));
  console.log(gray(`Calibration runs: ${runs}`));

  return days >= 5;
}

// ── HARD DISQUALIFIERS ───────────────────────────────────
function checkHardDisqualifiers() {
  console.log('\n── HARD DISQUALIFIERS ──');

  const total  = one(`SELECT COUNT(*) AS n FROM truth_events`).n;
  if (total < 100) { console.log(red(`Truth events < 100 (${total}) — HARD BLOCK`)); return false; }

  const memHits = one(`SELECT COUNT(*) AS n FROM decision_logs WHERE decision = 'MEMORY_HIT'`).n;
  if (memHits === 0) { console.log(red('Memory hits = 0 — HARD BLOCK')); return false; }

  const memCache = one(`SELECT COUNT(*) AS n FROM memory_cache`).n;
  if (memCache === 0) { console.log(red('Memory cache empty — HARD BLOCK')); return false; }

  // LLM dominance: if most truth events used patterns, we're good
  const patApps     = one(`SELECT COALESCE(SUM(times_used), 0) AS n FROM patterns`).n;
  const llmPct = total > 0 ? Math.round(100 * (total - patApps) / total) : 0;
  if (llmPct > 80) { console.log(red(`LLM dominates ${llmPct}% of paths (>80%) — HARD BLOCK`)); return false; }

  console.log(green('No hard disqualifiers triggered'));
  return true;
}

// ── MAIN ──────────────────────────────────────────────────
const checks = {
  truthLayer:        checkTruthLayer(),
  learningSignal:    checkLearningSignal(),
  llmReduction:      checkLLMReduction(),
  calibration:       checkCalibration(),
  policyMaturity:    checkPolicyMaturity(),
  failureDiversity:  checkFailureDiversity(),
  temporal:          checkTemporal(),
};

const hardOK = checkHardDisqualifiers();

console.log('\n══════════════════════════════════════');
const allGreen = Object.values(checks).every(Boolean) && hardOK;
console.log(allGreen ? 'READY for outreach' : 'NOT READY for outreach');
console.log('══════════════════════════════════════\n');

if (!allGreen) {
  console.log('Failed checks:');
  for (const [key, pass] of Object.entries(checks)) {
    if (!pass) console.log(`  - ${key}`);
  }
  if (!hardOK) console.log('  - hardDisqualifiers');
  console.log('\nContinue pilot. Re-check after more data collection.\n');
}

closeDb();
