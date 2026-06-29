import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { getDb, closeDb } from '../data/db.js';
import { TruthTracker } from '../services/truth/tracker.js';
import { TruthReconciler } from '../services/truth/reconciler.js';
import { Calibrator } from '../services/truth/calibrator.js';
import { TruthMetrics } from '../services/truth/metrics.js';

function cleanTables() {
  const db = getDb();
  db.exec(`PRAGMA foreign_keys = OFF;
    DELETE FROM truth_events;
    DELETE FROM truth_calibration;
    DELETE FROM accuracy_metrics;
    DELETE FROM knowledge_edges;
    DELETE FROM embeddings;
    DELETE FROM knowledge_nodes;
    DELETE FROM knowledge_index;
    PRAGMA foreign_keys = ON;`);
}

// DB stays open for entire process — server auto-closes via NODE_ENV=test

describe('TruthTracker', () => {
  let tracker;

  before(() => {
    cleanTables();
    tracker = new TruthTracker();
  });

  it('records a truth event', () => {
    const id = tracker.recordTruth({
      prNumber: 42, repo: 'test/repo', eventId: 'evt-1',
      fixType: 'lint', outcome: 'merged', mergedBy: 'user1',
      confidenceAtTime: 0.85, trustScoreAtTime: 0.72,
    });
    assert.ok(id > 0);
  });

  it('retrieves truth for a specific PR', () => {
    const truth = tracker.getTruthForPR(42, 'test/repo');
    assert.ok(truth);
    assert.strictEqual(truth.outcome, 'merged');
    assert.strictEqual(truth.fix_type, 'lint');
    assert.strictEqual(truth.confidence_at_time, 0.85);
  });

  it('returns outcome rates', () => {
    tracker.recordTruth({ prNumber: 43, repo: 'test/repo', fixType: 'lint', outcome: 'merged' });
    tracker.recordTruth({ prNumber: 44, repo: 'test/repo', fixType: 'lint', outcome: 'closed' });

    const rates = tracker.getOutcomeRate('test/repo', 'lint', 365);
    assert.ok(rates.total >= 3);
    assert.ok(rates.mergeRate > 0.5);
    assert.ok(rates.closeRate > 0);
  });

  it('returns all truth records', () => {
    const all = tracker.getAllTruth('lint');
    assert.ok(all.length >= 3);
  });

  it('returns accuracy grouped by fix type', () => {
    const accuracy = tracker.getAccuracyByFixType(365);
    const lint = accuracy.find(a => a.fixType === 'lint');
    assert.ok(lint);
    assert.ok(lint.total >= 3);
    assert.ok(lint.accuracy > 0);
  });
});

describe('TruthReconciler', () => {
  let reconciler;

  before(() => {
    cleanTables();
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO patterns (fix_type, pattern_hash, pattern_data, confidence, repos, global)
      VALUES ('lint', 'test-hash', '{}', 0.5, '["test/repo"]', 0)`).run();
    reconciler = new TruthReconciler();
  });

  it('reconciles merged PR truth across all layers', async () => {
    const result = await reconciler.reconcile({
      prNumber: 100, repo: 'test/repo2', fixType: 'dependency',
      outcome: 'merged', eventId: 'evt-merge-1',
      diffPreview: '+lodash@4.17.21',
    });
    assert.strictEqual(result.reconciled, true);
    assert.ok(result.layers.includes('pattern_memory'));
    assert.ok(result.layers.includes('calibration'));

    const db = getDb();
    const cal = db.prepare(`SELECT * FROM truth_calibration WHERE metric = ?`).get('test/repo2:dependency');
    assert.ok(cal);
    assert.strictEqual(cal.current_value, 1);

    const metric = db.prepare(`SELECT * FROM accuracy_metrics WHERE fix_type = 'dependency'`).get();
    assert.ok(metric);
    assert.strictEqual(metric.total, 1);
    assert.strictEqual(metric.correct, 1);
  });

  it('reconciles closed PR truth (decreases accuracy)', async () => {
    const result = await reconciler.reconcile({
      prNumber: 101, repo: 'test/repo2', fixType: 'dependency',
      outcome: 'closed', eventId: 'evt-close-1',
      diffPreview: '+bad-code',
    });
    assert.strictEqual(result.reconciled, true);

    const db = getDb();
    const cal = db.prepare(`SELECT * FROM truth_calibration WHERE metric = ?`).get('test/repo2:dependency');
    assert.ok(cal.current_value < 1);
    assert.strictEqual(cal.sample_size, 2);

    const metric = db.prepare(`SELECT * FROM accuracy_metrics WHERE fix_type = 'dependency'`).get();
    assert.strictEqual(metric.total, 2);
    assert.strictEqual(metric.correct, 1);
    assert.strictEqual(metric.incorrect, 1);
  });
});

describe('Calibrator', () => {
  let calibrator;

  before(() => {
    cleanTables();
    calibrator = new Calibrator();
    const db = getDb();
    db.prepare(`INSERT INTO truth_events (pr_number, repo, fix_type, outcome) VALUES (200, 'cal/repo', 'lint', 'merged')`).run();
    db.prepare(`INSERT INTO truth_events (pr_number, repo, fix_type, outcome) VALUES (201, 'cal/repo', 'lint', 'merged')`).run();
    db.prepare(`INSERT INTO truth_events (pr_number, repo, fix_type, outcome) VALUES (202, 'cal/repo', 'lint', 'merged')`).run();
    db.prepare(`INSERT INTO truth_events (pr_number, repo, fix_type, outcome) VALUES (203, 'cal/repo', 'lint', 'closed')`).run();
    db.prepare(`INSERT INTO truth_events (pr_number, repo, fix_type, outcome) VALUES (204, 'cal/repo', 'dependency', 'merged')`).run();
    db.prepare(`INSERT INTO truth_events (pr_number, repo, fix_type, outcome) VALUES (205, 'cal/repo', 'dependency', 'closed')`).run();
  });

  it('returns default threshold for unknown metrics', () => {
    const val = calibrator.getThreshold('nonexistent');
    assert.strictEqual(val, 0.5);
  });

  it('returns known default thresholds', () => {
    const val = calibrator.getThreshold('trust_approve');
    assert.strictEqual(val, 0.5);
  });

  it('calibrates thresholds from truth data', () => {
    const results = calibrator.calibrateAll();
    assert.ok(results.updated.length >= 1);

    const lintThreshold = calibrator.getThreshold('trust_lint');
    assert.ok(lintThreshold >= 0.3);
    assert.ok(lintThreshold <= 0.9);
  });

  it('getAllThresholds returns all configured thresholds', () => {
    calibrator.calibrateAll();
    const thresholds = calibrator.getAllThresholds();
    assert.ok(thresholds.trust_approve);
    assert.ok(thresholds.trust_reject);
    assert.ok(thresholds.reasoner_veto);
  });

  it('getApplicableThresholds returns repo+fixType specific thresholds', () => {
    calibrator.calibrateAll();
    const thresholds = calibrator.getApplicableThresholds('cal/repo', 'lint');
    assert.ok(typeof thresholds.reasonerVeto === 'number');
    assert.ok(typeof thresholds.trustApprove === 'number');
  });
});

describe('TruthMetrics', () => {
  let metrics;

  before(() => {
    cleanTables();
    metrics = new TruthMetrics();
    const db = getDb();
    db.prepare(`INSERT INTO accuracy_metrics (date, fix_type, total, correct, incorrect) VALUES (date('now'), 'lint', 10, 8, 2)`).run();
    db.prepare(`INSERT INTO accuracy_metrics (date, fix_type, total, correct, incorrect) VALUES (date('now'), 'dependency', 5, 3, 2)`).run();
    db.prepare(`INSERT INTO accuracy_metrics (date, fix_type, total, correct, incorrect) VALUES (date('now'), 'ci_failure', 3, 2, 1)`).run();
  });

  it('returns accuracy per fix type', () => {
    const acc = metrics.getAccuracy(365);
    assert.ok(acc.length >= 3);
    const lint = acc.find(a => a.fixType === 'lint');
    assert.strictEqual(lint.accuracy, 0.8);
  });

  it('returns precision/recall from truth events', () => {
    const pr = metrics.getPrecisionRecall(365);
    assert.ok(Array.isArray(pr));
  });

  it('returns accuracy trend over time', () => {
    const trend = metrics.getTrend(365);
    assert.ok(trend.length >= 1);
    assert.ok(trend[0].date);
    assert.ok(trend[0].accuracy >= 0);
  });

  it('returns summary with top fix types', () => {
    const summary = metrics.getSummary();
    assert.ok(summary.totalPRsTracked > 0);
    assert.ok(summary.topFixTypes.length >= 1);
    assert.strictEqual(summary.topFixTypes[0].fixType, 'lint');
  });
});
