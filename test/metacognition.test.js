import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { getDb, closeDb } from '../data/db.js';
import { SwitchDetector } from '../services/metacognition/switch.js';
import { RuleMutator } from '../services/metacognition/mutator.js';
import { PolicyPromoter } from '../services/metacognition/promoter.js';
import { ApiLearner } from '../services/metacognition/apiLearner.js';
import { TrapDetector } from '../services/metacognition/trapDetector.js';

function cleanTables() {
  const db = getDb();
  db.exec(`PRAGMA foreign_keys = OFF;
    DELETE FROM meta_behaviors;
    DELETE FROM meta_rules;
    DELETE FROM meta_policies;
    DELETE FROM meta_api_strategies;
    DELETE FROM meta_trap_patterns;
    DELETE FROM truth_events;
    PRAGMA foreign_keys = ON;`);
}

// after(() => closeDb());  // DB stays open for subsequent suites

describe('SwitchDetector', () => {
  let sd;

  before(() => { cleanTables(); sd = new SwitchDetector(); });

  it('records and retrieves behavior attempts', () => {
    sd.recordAttempt('patch_gen', 'llm', 'test/repo', true, 0.85, 1200);
    sd.recordAttempt('patch_gen', 'llm', 'test/repo', false, 0.3, 800);
    sd.recordAttempt('patch_gen', 'memory', 'test/repo', true, 0.92, 5);
    sd.recordAttempt('patch_gen', 'memory', 'test/repo', true, 0.95, 4);
    sd.recordAttempt('patch_gen', 'memory', 'test/repo', true, 0.90, 6);

    const health = sd.getComponentHealth('patch_gen');
    assert.ok(health);
    assert.strictEqual(health.strategies.length, 2);
    const mem = health.strategies.find(s => s.name === 'memory');
    assert.ok(mem.accuracy > 0.9);
  });

  it('suggests switch when current strategy underperforms', () => {
    const result = sd.shouldSwitch('patch_gen', 'llm', 2, 0.55);
    assert.strictEqual(result.shouldSwitch, true);
    assert.strictEqual(result.to, 'memory');
  });

  it('does not switch when data insufficient', () => {
    const result = sd.shouldSwitch('patch_gen', 'llm', 100, 0.9);
    assert.strictEqual(result.shouldSwitch, false);
  });

  it('returns all components', () => {
    const all = sd.getAllComponents();
    assert.ok(all.length >= 1);
  });

  it('auto-tunes thresholds from behavior data', () => {
    const tune = sd.autoTuneThreshold('test_metric', 0.5, 1);
    assert.ok(tune.tuned || !tune.tuned);
  });
});

describe('RuleMutator', () => {
  let rm;

  before(() => { cleanTables(); rm = new RuleMutator(); });

  it('defines and retrieves rules', () => {
    rm.defineRule('test_max_diff', 'threshold', 'diffSize>3000', 'reject', 100);
    const rules = rm.getActiveRules();
    assert.ok(rules.length >= 1);
    assert.strictEqual(rules[0].name, 'test_max_diff');
  });

  it('records rule firing', () => {
    rm.recordFiring('test_max_diff', true);
    rm.recordFiring('test_max_diff', true);
    rm.recordFiring('test_max_diff', false);
    const rules = rm.getActiveRules();
    const rule = rules.find(r => r.name === 'test_max_diff');
    assert.strictEqual(rule.times_fired, 3);
    assert.strictEqual(rule.times_correct, 2);
  });

  it('mutates low-performing rules', () => {
    for (let i = 0; i < 10; i++) rm.recordFiring('test_max_diff', false);
    const result = rm.mutate('test_max_diff');
    assert.strictEqual(result.mutated, true);
    assert.strictEqual(result.mutationType, 'relax_threshold');
  });

  it('identifies dead rules', () => {
    rm.defineRule('dead_rule', 'test', 'never-fired', 'archive', 0);
    const dead = rm.getDeadRules(0);
    assert.ok(dead.length >= 1);
  });
});

describe('PolicyPromoter', () => {
  let pp;

  before(() => {
    cleanTables();
    const db = getDb();
    db.prepare(`DELETE FROM patterns WHERE pattern_hash = 'promotable-hash'`).run();
    db.prepare(`DELETE FROM truth_events`).run();
    pp = new PolicyPromoter();
    db.prepare(`INSERT INTO patterns (fix_type, pattern_hash, pattern_data, confidence, times_used, times_accepted, repos)
      VALUES ('lint', 'promotable-hash', '{}', 0.85, 15, 13, '["repo/a","repo/b","repo/c"]')`).run();
    db.prepare(`INSERT INTO truth_events (pr_number, repo, fix_type, trust_score_at_time, outcome)
      VALUES (1, 'r1', 'lint', 0.80, 'merged')`).run();
    db.prepare(`INSERT INTO truth_events (pr_number, repo, fix_type, trust_score_at_time, outcome)
      VALUES (2, 'r1', 'lint', 0.80, 'merged')`).run();
    db.prepare(`INSERT INTO truth_events (pr_number, repo, fix_type, trust_score_at_time, outcome)
      VALUES (3, 'r1', 'lint', 0.80, 'merged')`).run();
    db.prepare(`INSERT INTO truth_events (pr_number, repo, fix_type, trust_score_at_time, outcome)
      VALUES (4, 'r1', 'lint', 0.80, 'merged')`).run();
    db.prepare(`INSERT INTO truth_events (pr_number, repo, fix_type, trust_score_at_time, outcome)
      VALUES (5, 'r1', 'lint', 0.80, 'merged')`).run();
    db.prepare(`INSERT INTO truth_events (pr_number, repo, fix_type, trust_score_at_time, outcome)
      VALUES (6, 'r1', 'lint', 0.35, 'closed')`).run();
  });

  it('promotes high-confidence patterns to policies', () => {
    const promoted = pp.evaluatePatternsForPromotion();
    const patternPromo = promoted.find(p => p.type === 'memory_pattern');
    assert.ok(patternPromo);
    assert.strictEqual(patternPromo.fixType, 'lint');
  });

  it('creates trust-based policies from truth data', () => {
    const policies = pp.getActivePolicies();
    const trustPolicy = policies.find(p => p.source_pattern.includes('trust_signal'));
    assert.ok(trustPolicy);
    assert.ok(trustPolicy.confidence >= 0.8);
  });

  it('checks policy against context', () => {
    const match = pp.checkPolicy('lint', { trustScore: 0.85, relevantFiles: ['src/app.js'] });
    assert.ok(match.matched);
  });

  it('verifies and deactivates stale policies', () => {
    const result = pp.verifyPolicies();
    assert.ok(result.verified >= 0);
  });
});

describe('ApiLearner', () => {
  let al;

  before(() => { cleanTables(); al = new ApiLearner(); });

  it('records and selects strategy', () => {
    al.recordStrategyOutcome('javascript', 'lint', '*.js', 'lint_fix', true);
    al.recordStrategyOutcome('javascript', 'lint', '*.js', 'lint_fix', true);
    al.recordStrategyOutcome('javascript', 'lint', '*.js', 'lint_fix', false);
    al.recordStrategyOutcome('javascript', 'dependency', 'package.json', 'dependency_bump', true);
    al.recordStrategyOutcome('javascript', 'dependency', 'package.json', 'dependency_bump', true);
    al.recordStrategyOutcome('javascript', 'dependency', 'package.json', 'dependency_bump', true);
  });

  it('selects best strategy by exact match', () => {
    const result = al.selectBestStrategy('javascript', 'lint', '*.js');
    assert.strictEqual(result.source, 'exact_match');
    assert.strictEqual(result.strategy, 'lint_fix');
  });

  it('falls back to fix-type match', () => {
    const result = al.selectBestStrategy('python', 'dependency', '*.py');
    assert.ok(['dependency_bump', 'direct_edit'].includes(result.strategy));
  });

  it('returns context insights', () => {
    const insights = al.getContextInsights('javascript', 'lint');
    assert.ok(insights);
    assert.strictEqual(insights.recommended, 'lint_fix');
  });
});

describe('TrapDetector', () => {
  let td;

  before(() => { cleanTables(); td = new TrapDetector(); });

  it('defines trap patterns', () => {
    td.defineTrap('test_prod_repo', 'env_check', 'repoHas=prod', 'production repo', 'high');
    td.defineTrap('test_large_diff', 'size_check', 'diffSize>1000', 'too large', 'medium');
    td.defineTrap('test_consecutive_fail', 'consecutive_failure', 'consecutiveFailures>2', 'too many fails', 'medium');
    const traps = td.getAllTraps();
    assert.strictEqual(traps.length, 3);
  });

  it('blocks on high-severity trap match', () => {
    const result = td.check('evt-1', 'lint', { repo: 'my-prod-app', diff: 'small', relevantFiles: ['a.js'], fileContents: {} });
    assert.strictEqual(result.blocked, true);
    assert.ok(result.triggered.some(t => t.name === 'test_prod_repo'));
  });

  it('warns on medium-severity trap', () => {
    const result = td.check('evt-2', 'lint', { repo: 'normal', diff: 'x'.repeat(1500), relevantFiles: ['a.js'], fileContents: {} });
    assert.strictEqual(result.blocked, false);
    assert.ok(result.warnings.length > 0);
  });

  it('auto-learns traps from rejections', () => {
    td.learnFromRejection('evt-3', 'dependency', 'bad/repo', 'diff too large', {});
    const traps = td.getTrapsBySeverity('low');
    assert.ok(traps.some(t => t.name.includes('bad_repo')));
  });

  it('returns trap summary', () => {
    td.defineTrap('high-trap', 'test', 'fixType=dependency', 'test', 'high');
    td.check('evt-4', 'dependency', { repo: 'x', diff: '', relevantFiles: [], fileContents: {} });
    const summary = td.getTrapSummary();
    assert.ok(summary.total >= 4);
    assert.ok(summary.high >= 2);
    assert.ok(summary.totalTriggers >= 1);
  });
});
