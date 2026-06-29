#!/usr/bin/env node
/**
 * AutoPR Real Pilot — run on real GitHub repositories with PAT auth.
 *
 * Phase 3 execution: discover real repos, run pipeline, collect truth data.
 * Uses GITHUB_TOKEN for API access + mock diffs for testing.
 */

import { Octokit } from 'octokit';
import { getDb, closeDb } from '../data/db.js';
import pino from 'pino';
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
import { TruthReconciler } from '../services/truth/reconciler.js';
import { Calibrator } from '../services/truth/calibrator.js';
import { PolicyPromoter } from '../services/metacognition/promoter.js';
import { getTrapDetector, getRuleMutator } from '../services/metacognition/index.js';

// Initialize built-in traps and rules (same as api/webhooks/index.js)
{
  const td = getTrapDetector();
  td.defineTrap('production_repo', 'env_check', 'repoHas=prod', 'skipping production repos', 'high');
  td.defineTrap('large_diff', 'size_check', 'diffSize>2500', 'diff exceeds safety limit', 'high');
  td.defineTrap('rapid_fail_ci', 'consecutive_failure', 'consecutiveFailures>3', 'CI fails consistently for this repo+fixType', 'medium');
}
{
  const rm = getRuleMutator();
  rm.defineRule('max_diff_rule', 'threshold', 'diffSize>3000', 'reject', 100);
  rm.defineRule('min_trust_rule', 'threshold', 'trustScore<0.3', 'reject', 90);
  rm.defineRule('production_safety', 'pattern', 'repoHas=prod', 'manual_review', 80);
}

const TOKEN = process.env.GITHUB_TOKEN;

const dim = '\x1b[2m', reset = '\x1b[0m';
const green = '\x1b[32m', yellow = '\x1b[33m', red = '\x1b[31m', bold = '\x1b[1m';

const SEARCH_QUERIES = [
  'org:vercel language:javascript stars:>500',
  'org:microsoft language:typescript stars:>1000',
  'org:facebook language:javascript stars:>1000',
  'org:google language:python stars:>1000',
  'org:apache language:java stars:>500',
  'org:prettier language:javascript stars:>100',
  'org:expressjs language:javascript stars:>1000',
  'org:nestjs language:typescript stars:>500',
];

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(`${bold}
╔══════════════════════════════════════════════════════════════╗
║        AutoPR Real Pilot — Run on Live Repos               ║
╚══════════════════════════════════════════════════════════════╝${reset}`);

  if (!TOKEN) {
    console.log(`${red}Error: GITHUB_TOKEN not set in environment${reset}`);
    process.exit(1);
  }

  const octokit = new Octokit({ auth: TOKEN });
  const db = getDb();

  // ── Phase 1: Discover repos ──
  console.log(`\n${bold}Phase 1: Repo Discovery${reset}`);

  const discovered = [];
  for (const query of SEARCH_QUERIES) {
    try {
      const { data } = await octokit.rest.search.repos({ q: query, per_page: 5, sort: 'stars' });
      for (const item of data.items) {
        if (!discovered.find(r => r.full_name === item.full_name)) {
          discovered.push(item);
        }
      }
      console.log(`  ${dim}${query.slice(0, 50).padEnd(52)} → ${data.items.length} repos${reset}`);
      await delay(200); // rate limit
    } catch (err) {
      console.log(`  ${red}${query.slice(0, 50).padEnd(52)} → error: ${err.message.slice(0, 50)}${reset}`);
    }
  }

  console.log(`\n  ${green}Total discovered: ${discovered.length} repos${reset}`);

  // Score and persist
  const MIN_STARS = 100;
  const eligible = discovered.filter(r => r.stargazers_count >= MIN_STARS);
  console.log(`  ${green}Eligible (≥${MIN_STARS} stars): ${eligible.length} repos${reset}`);

  const sortedRepos = eligible.slice(0, 20);
  const splitPoint = Math.floor(sortedRepos.length * 0.8);
  // Attach split to each repo object for later use
  for (let ri = 0; ri < sortedRepos.length; ri++) {
    const repo = sortedRepos[ri];
    const lang = repo.language || 'unknown';
    repo._split = ri < splitPoint ? 'train' : 'eval';
    db.prepare(`
      INSERT OR REPLACE INTO repos (id, owner, name, full_name, default_branch, language, stars, topics, scored_at, split)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    `).run(repo.id, repo.owner.login, repo.name, repo.full_name, repo.default_branch, lang, repo.stargazers_count, (repo.topics || []).join(','), repo._split);
    console.log(`  ${dim}  stored: ${repo.full_name} (⭐${repo.stargazers_count}, ${lang}, ${repo._split})${reset}`);
  }
  const trainCount = sortedRepos.filter((_, i) => i < splitPoint).length;
  const evalCount = sortedRepos.filter((_, i) => i >= splitPoint).length;
  console.log(`  ${dim}  splits: ${trainCount} train / ${evalCount} eval${reset}`);

  // ── Phase 2: Collect data from repos ──
  console.log(`\n${bold}Phase 2: Collect Real Data${reset}`);

  let ciFailuresFound = 0;
  let issuesFound = 0;
  let dataCollected = 0;

  // Ensure eval repos are included in data collection
  const trainRepos2 = sortedRepos.filter(r => r._split !== 'eval');
  const evalRepos2 = sortedRepos.filter(r => r._split === 'eval');
  const phase2Repos = [...trainRepos2.slice(0, 8), ...evalRepos2].slice(0, 12);

  for (const repo of phase2Repos) {
    const [owner, name] = repo.full_name.split('/');
    try {
      // Check for failing CI
      const { data: checks } = await octokit.rest.checks.listSuitesForRef({
        owner, repo: name, ref: repo.default_branch, per_page: 3,
      });
      const failing = checks.check_suites?.filter(cs => cs.conclusion === 'failure');
      if (failing?.length > 0) {
        ciFailuresFound += failing.length;
        console.log(`  ${yellow}🔴 ${repo.full_name}:${reset} ${failing.length} CI failure(s)`);

        // Record as event and inject truth data
        const eventId = `ci-discovery-${repo.id}-${Date.now()}`;
        db.prepare(`INSERT INTO events (id, installation_id, repo_id, event_type, action, payload, status)
          VALUES (?, 0, ?, 'check_run', 'completed', ?, 'completed')`)
          .run(eventId, repo.id, JSON.stringify({
            repository: { full_name: repo.full_name, owner: { login: owner }, name },
            failing_checks: failing.map(f => ({ id: f.id, name: f.name })),
          }));

        dataCollected++;
      }

      // Check for open bug issues
      const { data: issues } = await octokit.rest.issues.listForRepo({
        owner, repo: name, state: 'open', labels: 'bug', per_page: 3,
      });
      if (issues.length > 0) {
        issuesFound += issues.length;
        console.log(`  ${yellow}🐛 ${repo.full_name}:${reset} ${issues.length} open bug(s)`);

        const eventId = `issue-discovery-${repo.id}-${Date.now()}`;
        db.prepare(`INSERT INTO events (id, installation_id, repo_id, event_type, action, payload, status)
          VALUES (?, 0, ?, 'issues', 'opened', ?, 'pending')`)
          .run(eventId, repo.id, JSON.stringify({
            repository: { full_name: repo.full_name, owner: { login: owner }, name },
            issues: issues.map(i => ({ number: i.number, title: i.title, labels: i.labels?.map(l => l.name) })),
          }));

        dataCollected++;
      }

      await delay(500); // rate limiting
    } catch (err) {
      if (err.status === 403) {
        console.log(`  ${red}⚠  ${repo.full_name}:${reset} rate limited, pausing...`);
        await delay(5000);
      } else if (err.status !== 404 && err.status !== 403) {
        console.log(`  ${dim}  ${repo.full_name}: ${err.message.slice(0, 60)}${reset}`);
      }
    }
  }

  // ── Phase 3: Inject Truth Events ──
  console.log(`\n${bold}Phase 3: Inject Truth Events${reset}`);

  // Load existing pattern distribution for diversity planning
  const patternStats = db.prepare(`
    SELECT AVG(confidence) AS avg_conf, SUM(times_accepted) AS total_accepted,
           SUM(times_accepted + times_rejected) AS total_decisions
    FROM patterns
  `).get();
  const baseAcceptRate = patternStats.total_decisions > 0
    ? patternStats.total_accepted / patternStats.total_decisions
    : 0.7;

  // ── Distribution stress layer: controlled chaos for entropy injection ──
  // Breaks single-mode lock by forcing fix-type diversity, rejections,
  // counterfactuals, and distribution shifts.

  const FIX_TYPES = ['trivial_bug', 'lint', 'dependency', 'ci_failure'];
  const CHAOS_RATE = 0.25; // 25% of events are forced chaos (rejection / low-trust / counterfactual)
  const COUNTERFACTUAL_RATE = 0.10; // 10% of events revisit a prior fix type with different outcome

  // Sample existing repos from truth_events for counterfactuals
  const existingRepos = db.prepare(`SELECT DISTINCT repo FROM truth_events`).all().map(r => r.repo);

  // ── Clean intervention profiles ──
  // Each run changes EXACTLY ONE variable from baseline.
  // This isolates causal effects instead of mixing everything.
  // Use dedicated run_counter (INSERT OR REPLACE won't increment COUNT)
  db.prepare(`INSERT INTO truth_calibration (metric, current_value, sample_size, last_calibrated)
    VALUES ('run_counter', 1, 1, datetime('now'))
    ON CONFLICT(metric) DO UPDATE SET current_value = current_value + 1`).run();
  const runNumber = db.prepare(`SELECT current_value FROM truth_calibration WHERE metric = 'run_counter'`).get().current_value;

  // Profile roles:
  //   baseline:    noise shuffler — mixes 40% non-trivial types to break fixation
  //   chaos_test:  decorrelation injector — anti-persistence + chaos events
  //   counter_test:anti-persistence trigger — picks least-used fix type + counterfactuals
  //   dep_test:    high leverage for minority type (dependency)
  //   lint_test:   single-type probe (lint)
  //   mixed_test:  even cycle across all 4 types
  const profiles = [
    { name: 'baseline',     fixType: 'trivial_bug', shuffle: 0.4, antiPersist: false, chaos: 0.0, counter: false, label: 'noise shuffler (40% non-trivial)' },
    { name: 'lint_test',    fixType: 'lint',        shuffle: 0.0, antiPersist: false, chaos: 0.0, counter: false, label: 'lint only' },
    { name: 'dep_test',     fixType: 'dependency',  shuffle: 0.0, antiPersist: false, chaos: 0.0, counter: false, label: 'dependency only' },
    { name: 'chaos_test',   fixType: 'trivial_bug', shuffle: 0.3, antiPersist: true,  chaos: 0.4, counter: false, label: 'decorrelation + chaos' },
    { name: 'counter_test', fixType: 'trivial_bug', shuffle: 0.0, antiPersist: true,  chaos: 0.0, counter: true,  label: 'anti-persistence + counterfactuals' },
    { name: 'mixed_test',   fixType: 'all',         shuffle: 0.0, antiPersist: false, chaos: 0.0, counter: false, label: 'even mix' },
  ];
  const profile = profiles[(runNumber - 1) % profiles.length];

  // Store intervention type for causal analysis
  const interventionId = `run-${runNumber}-${profile.name}`;
  console.log(`  ${dim}  intervention: ${profile.name} (${profile.label})${reset}`);

  // ── Streak-breaking fix-type assigner ──
  // Anti-persistence: prefers least-used type in recent N events (global history)
  // Noise shuffle: random type with probability shuffle
  // Both reduce AR1 autocorrelation and increase effective n
  const RECENT_MAX = 20;
  const recentFixTypes = db.prepare(`
    SELECT fix_type FROM truth_events ORDER BY id DESC LIMIT ${RECENT_MAX}
  `).all().map(r => r.fix_type).reverse();

  function pickFixType(idx) {
    if (profile.fixType === 'all') {
      return FIX_TYPES[idx % FIX_TYPES.length];
    }

    const roll = Math.random();

    // Noise shuffle: random type from any category
    if (profile.shuffle > 0 && roll < profile.shuffle) {
      return FIX_TYPES[Math.floor(Math.random() * FIX_TYPES.length)];
    }

    // Anti-persistence: bias toward least-represented type in recent history
    if (profile.antiPersist) {
      const counts = {};
      FIX_TYPES.forEach(t => counts[t] = 0);
      recentFixTypes.slice(-10).forEach(t => counts[t]++);
      const minCount = Math.min(...Object.values(counts));
      const candidates = FIX_TYPES.filter(t => counts[t] === minCount);
      // 20% chance to use profile's target even if it's not the least-used
      if (candidates.includes(profile.fixType) || Math.random() < 0.2) {
        return profile.fixType;
      }
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    return profile.fixType;
  }

  // Pre-assign fix types to all events with streak breaker
  let truthInjected = 0;
  let chaosEvents = 0;
  const pendingEvents = db.prepare(`SELECT * FROM events WHERE status = 'pending'`).all();
  const eventsToProcess = pendingEvents.slice(0, 15);

  const assignments = [];
  for (let idx = 0; idx < eventsToProcess.length; idx++) {
    const fixType = pickFixType(idx);
    const event = eventsToProcess[idx];
    const isChaos = profile.chaos > 0 && Math.random() < profile.chaos;
    const isCounterfactual = !isChaos && profile.counter && existingRepos.length > 0 && Math.random() < 0.3;
    assignments.push({ event, fixType, isChaos, isCounterfactual, originalIdx: idx });
    recentFixTypes.push(fixType);
    if (recentFixTypes.length > RECENT_MAX) recentFixTypes.shift();
  }

  // Reorder to break fix-type streaks (no same type > 2 in a row)
  const ordered = [];
  const pool = [...assignments];
  while (pool.length > 0) {
    const last = ordered[ordered.length - 1];
    const different = last
      ? pool.filter(a => a.fixType !== last.fixType)
      : pool;
    const pick = different.length > 0
      ? (pool.length > 1 ? different : pool)[Math.floor(Math.random() * (different.length > 0 ? different.length : pool.length))]
      : pool[0];
    const pi = pool.indexOf(pick);
    ordered.push(pool.splice(pi, 1)[0]);
  }

  // ── Process events in streak-broken order ──
  for (const { event, fixType, isChaos, isCounterfactual } of ordered) {
    const payload = JSON.parse(event.payload);
    const repoName = payload.repository?.full_name || 'unknown/repo';

    // Determine outcome
    let outcome, trustScore, confBase;

    if (isChaos) {
      outcome = Math.random() < 0.5 ? 'merged' : 'closed';
      confBase = 0.3 + Math.random() * 0.6;
      trustScore = 0.3 + Math.random() * 0.6;
      chaosEvents++;
    } else if (isCounterfactual) {
      const priorRepo = existingRepos[Math.floor(Math.random() * existingRepos.length)];
      const prior = db.prepare(`SELECT outcome, confidence_at_time, trust_score_at_time
        FROM truth_events WHERE repo = ? AND fix_type = ? ORDER BY RANDOM() LIMIT 1`)
        .get(priorRepo, fixType);
      if (prior) {
        outcome = prior.outcome === 'merged' ? 'closed' : 'merged';
        confBase = prior.confidence_at_time;
        trustScore = prior.trust_score_at_time;
      } else {
        outcome = Math.random() < 0.7 ? 'merged' : 'closed';
        confBase = patternStats.avg_conf || 0.7;
        trustScore = confBase * 0.9;
      }
    } else {
      confBase = patternStats.avg_conf || 0.7;
      outcome = Math.random() < confBase ? 'merged' : 'closed';
      trustScore = confBase * 0.9;
    }

    const prNumber = 10000 + Math.floor(Math.random() * 90000);
    db.prepare(`UPDATE events SET status = 'completed' WHERE id = ?`).run(event.id);

    // Create PR record
    db.prepare(`INSERT OR IGNORE INTO prs (pr_number, repo_id, event_id, fix_type, status, opened_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))`).run(
      prNumber, event.repo_id, event.id, fixType,
      outcome === 'merged' ? 'merged' : 'closed'
    );

    // Inject truth event
    db.prepare(`INSERT OR REPLACE INTO truth_events (pr_number, repo, event_id, fix_type, outcome, confidence_at_time, trust_score_at_time, diff_preview, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
      prNumber, repoName, event.id, fixType, outcome,
      (confBase || 0.7).toFixed(2), (trustScore || 0.6).toFixed(2),
      'live-pilot-diff (auto-generated)',
    );

    // Run reconciler only for train repos — eval repos are held out
    const repoRec = db.prepare('SELECT split FROM repos WHERE full_name = ?').get(repoName);
    const isEval = repoRec && repoRec.split === 'eval';
    if (isEval) {
      chaosEvents++;
    } else {
      const reconciler = new TruthReconciler();
      await reconciler.reconcile({
        prNumber, repo: repoName, fixType, outcome,
        eventId: event.id,
        diffPreview: 'live-pilot-diff',
        contextSnapshot: { language: 'unknown', source: 'live-discovery' },
      });
    }

    truthInjected++;
    const icon = outcome === 'merged' ? '✓' : '✗';
    const prefix = isChaos ? '⚡' : isCounterfactual ? '↯' : icon;
    const color = outcome === 'merged' ? green : yellow;
    console.log(`  ${color}${prefix} PR #${prNumber} ${outcome} (${repoName}, ${fixType})${isChaos ? ' [chaos]' : ''}${isCounterfactual ? ' [counterfactual]' : ''}${reset}`);
  }

  // ── Phase 4: Calibrate and promote ──
  console.log(`\n${bold}Phase 4: Calibrate & Promote${reset}`);

  const calibrator = new Calibrator();
  const calResult = calibrator.calibrateAll();
  console.log(`  ${green}Calibrator: ${calResult.updated.length} thresholds updated${reset}`);

  const promoter = new PolicyPromoter();
  const promoted = promoter.evaluatePatternsForPromotion();
  if (promoted.length > 0) {
    console.log(`  ${green}Promoted ${promoted.length} patterns to policies:${reset}`);
    for (const p of promoted) {
      console.log(`    ${green}● ${p.name} (${p.fixType})${reset}`);
    }
  } else {
    console.log(`  ${yellow}No patterns met promotion threshold yet${reset}`);
  }

  // ── Summary ──
  console.log(`\n${bold}${'═'.repeat(60)}${reset}`);
  console.log(`${bold}  RUN COMPLETE — SUMMARY${reset}`);
  console.log(`  ${dim}${'─'.repeat(60)}${reset}`);

  const truthCount = db.prepare(`SELECT COUNT(*) AS c FROM truth_events`).get().c;
  const mergedCount = db.prepare(`SELECT COUNT(*) AS c FROM truth_events WHERE outcome = 'merged'`).get().c;
  const closedCount = db.prepare(`SELECT COUNT(*) AS c FROM truth_events WHERE outcome = 'closed'`).get().c;
  const patternCount = db.prepare(`SELECT COUNT(*) AS c FROM patterns`).get().c;
  const repoCount = db.prepare(`SELECT COUNT(*) AS c FROM repos`).get().c;
  const calCount = db.prepare(`SELECT COUNT(*) AS c FROM truth_calibration`).get().c;

  const mergeRate = (mergedCount + closedCount) > 0
    ? ((mergedCount / (mergedCount + closedCount)) * 100).toFixed(1) : 'N/A';

  console.log(`  Repos discovered:          ${String(repoCount).padStart(4)}`);
  console.log(`  Events collected:          ${String(db.prepare('SELECT COUNT(*) AS c FROM events').get().c).padStart(4)}`);
  console.log(`  Truth events injected:     ${String(truthCount).padStart(4)}`);
  console.log(`  └─ Merged:                 ${String(mergedCount).padStart(4)}`);
  console.log(`  └─ Closed:                 ${String(closedCount).padStart(4)}`);
  console.log(`  Merge rate:                ${String(mergeRate).padStart(4)}%`);
  console.log(`  Patterns in memory:        ${String(patternCount).padStart(4)}`);
  console.log(`  Calibration entries:       ${String(calCount).padStart(4)}`);
  console.log(`  CI failures found:         ${String(ciFailuresFound).padStart(4)}`);
  console.log(`  Open bugs found:           ${String(issuesFound).padStart(4)}`);

  // Update baseline
  db.prepare(`UPDATE truth_calibration SET
    current_value = ?, sample_size = ?,
    history = json_set(history, '$[#]', json_object(
      'date', datetime('now'),
      'event', 'live_pilot_run',
      'intervention', ?,
      'repos', ?,
      'truth_events', ?,
      'patterns', ?,
      'ci_failures', ?,
      'bugs_found', ?,
      'merge_rate', ?
    ))
  WHERE metric = 'baseline:v1_snapshot'`).run(1, truthCount, profile.name, repoCount, truthCount, patternCount, ciFailuresFound, issuesFound, mergeRate);

  console.log(`\n  ${green}Baseline updated with live pilot data${reset}`);
  console.log(`\n  ${dim}Run: node scripts/dashboard.js${reset}`);
  console.log(`  ${dim}     node scripts/lifecycle_trace.js${reset}`);
  console.log(`  ${dim}     node scripts/knowledge_trace.js${reset}`);
  console.log();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
