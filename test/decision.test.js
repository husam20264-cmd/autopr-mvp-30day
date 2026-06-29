import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { getDb, closeDb } from '../data/db.js';
import { DecisionTracer } from '../services/decision/tracer.js';

function cleanTables() {
  const db = getDb();
  db.exec(`PRAGMA foreign_keys = OFF;
    DELETE FROM decision_alternatives;
    DELETE FROM causal_edges;
    DELETE FROM decision_logs;
    DELETE FROM prs;
    DELETE FROM events;
    DELETE FROM repos;
    DELETE FROM installations;
    PRAGMA foreign_keys = ON;`);
  db.prepare(`INSERT INTO installations (id, account_login, account_type) VALUES (0, 'test', 'user')`).run();
  db.prepare(`INSERT INTO installations (id, account_login, account_type) VALUES (1, 'test-owner', 'user')`).run();
  db.prepare(`INSERT INTO repos (id, owner, name, full_name, installation_id) VALUES (0, 'test', 'repo', 'test/repo', 0)`).run();
  db.prepare(`INSERT INTO repos (id, owner, name, full_name, installation_id) VALUES (1, 'test', 'repo2', 'test/repo2', 1)`).run();
}

describe('DecisionTracer', () => {
  let tracer;
  let db;

  before(() => {
    db = getDb();
    cleanTables();
    tracer = new DecisionTracer();
    db.prepare(`INSERT OR IGNORE INTO events (id, installation_id, repo_id, event_type, payload, status) VALUES ('trace-test-1', 0, 0, 'push', '{}', 'pending')`).run();
    db.prepare(`INSERT OR IGNORE INTO events (id, installation_id, repo_id, event_type, payload, status) VALUES ('trace-e2e-1', 1, 1, 'push', '{}', 'pending')`).run();
  });

  // after(() => closeDb());

  it('starts a trace and creates root node', () => {
    const rootId = tracer.startTrace('trace-test-1', { eventType: 'push' });
    assert.ok(rootId > 0);

    const root = db.prepare(`SELECT * FROM decision_logs WHERE id = ?`).get(rootId);
    assert.strictEqual(root.event_id, 'trace-test-1');
    assert.strictEqual(root.step, 'trace_root');
    assert.strictEqual(root.decision, 'pipeline_started');
  });

  it('logs a decision with reasoning chain', () => {
    const decisionId = tracer.logDecision({
      eventId: 'trace-test-1',
      step: 'classifier',
      decision: 'CLASSIFY_lint',
      confidence: 0.85,
      reasoning: ['event is push to package.json', 'dependency update detected', 'fixType = dependency'],
      input: { eventType: 'push' },
      output: { fixType: 'lint' },
      durationMs: 12,
    });
    assert.ok(decisionId > 0);

    const log = db.prepare(`SELECT * FROM decision_logs WHERE id = ?`).get(decisionId);
    assert.strictEqual(log.step, 'classifier');
    assert.strictEqual(log.decision, 'CLASSIFY_lint');
    assert.ok(log.parent_id > 0);

    const chain = JSON.parse(log.reasoning_chain);
    assert.ok(Array.isArray(chain));
    assert.ok(chain.length >= 1);
  });

  it('records rejected alternatives', () => {
    const decisionId = tracer.logDecision({
      eventId: 'trace-test-1',
      step: 'memory_lookup',
      decision: 'MEMORY_HIT',
      confidence: 0.92,
      reasoning: ['pattern match found for eslint-null-check'],
      alternatives: [
        { alternative: 'call LLM', reasonRejected: 'pattern match found with confidence 0.92', score: 0.08 },
        { alternative: 'skip PR', reasonRejected: 'event is actionable', score: 0.15 },
      ],
      input: { fixType: 'lint' },
      output: { source: 'memory', confidence: 0.92 },
    });

    const alternatives = tracer.getAlternatives(decisionId);
    assert.strictEqual(alternatives.length, 2);
    assert.strictEqual(alternatives[0].alternative, 'call LLM');
    assert.strictEqual(alternatives[1].alternative, 'skip PR');
  });

  it('builds causal edges between decisions', () => {
    const decisions = db.prepare(`SELECT * FROM decision_logs WHERE event_id = ? ORDER BY id ASC`).all('trace-test-1');
    const edges = db.prepare(`SELECT * FROM causal_edges`).all();
    assert.ok(edges.length >= decisions.length - 1);
  });

  it('getTrace returns full decision chain with causal graph', () => {
    const trace = tracer.getTrace('trace-test-1');
    assert.ok(trace.decisions.length >= 3);
    assert.ok(Array.isArray(trace.causalGraph));
    assert.ok(trace.causalGraph.length >= 1);

    for (const d of trace.decisions) {
      assert.ok(Array.isArray(d.reasoning_chain));
      assert.ok(typeof d.input_snapshot === 'object');
      assert.ok(typeof d.output_snapshot === 'object');
    }
  });

  it('explain returns structured summary', () => {
    const explanation = tracer.explain('trace-test-1');
    assert.strictEqual(explanation.eventId, 'trace-test-1');
    assert.ok(explanation.totalSteps >= 3);
    assert.ok(Array.isArray(explanation.chain));
    assert.ok(explanation.chain[0].step);
    assert.ok(explanation.chain[0].why);
    assert.ok(typeof explanation.chain[0].confidence === 'number');
  });

  it('why returns reasoning path with alternatives', () => {
    const why = tracer.why('trace-test-1');
    assert.ok(why !== null);
    assert.strictEqual(why.eventId, 'trace-test-1');
    assert.ok(why.outcome);
    assert.ok(typeof why.finalConfidence === 'number');
    assert.ok(Array.isArray(why.reasoningPath));
    assert.ok(why.summary.length > 0);

    for (const step of why.reasoningPath) {
      assert.ok(step.what);
      assert.ok(Array.isArray(step.alternativesConsidered));
    }
  });

  it('getPipelineInsights returns bottleneck analysis', () => {
    const insights = tracer.getPipelineInsights('trace-test-1');
    assert.ok(insights !== null);
    assert.strictEqual(insights.eventId, 'trace-test-1');
    assert.ok(insights.duration >= 0);
    assert.ok(insights.steps >= 3);
    assert.ok(insights.decisionCount >= 2);
    assert.ok(typeof insights.alternativesConsidered === 'number');
    assert.ok(Array.isArray(insights.bottlenecks));
  });

  it('endTrace sets final status', () => {
    tracer.endTrace('trace-test-1', 'completed');

    const lastDecision = db.prepare(`
      SELECT * FROM decision_logs WHERE event_id = ? ORDER BY id DESC LIMIT 1
    `).get('trace-test-1');

    const output = JSON.parse(lastDecision.output_snapshot);
    assert.strictEqual(output.status, 'completed');
  });

  it('tracks a complete pipeline trace end-to-end', () => {
    tracer.startTrace('trace-e2e-1', { eventType: 'push' });

    tracer.logDecision({
      eventId: 'trace-e2e-1', step: 'classifier', decision: 'CLASSIFY_dependency',
      confidence: 0.9, reasoning: ['dependency update in package.json'],
    });

    tracer.logDecision({
      eventId: 'trace-e2e-1', step: 'billing', decision: 'LIMIT_OK',
      confidence: 1.0, reasoning: ['usage within free tier (3/5 used)'],
    });

    tracer.logDecision({
      eventId: 'trace-e2e-1', step: 'knowledge_reasoner', decision: 'PROCEED',
      confidence: 0.75, reasoning: ['similar fix accepted in this repo before'],
    });

    tracer.logDecision({
      eventId: 'trace-e2e-1', step: 'memory_lookup', decision: 'MEMORY_MISS',
      confidence: 0.3, reasoning: ['no pattern match found'],
      alternatives: [
        { alternative: 'use cached diff', reasonRejected: 'no cache entry', score: 0 },
      ],
    });

    tracer.logDecision({
      eventId: 'trace-e2e-1', step: 'patch_generation', decision: 'LLM_GENERATED',
      confidence: 0.6, reasoning: ['patch generated by gpt-4o-mini'],
    });

    tracer.logDecision({
      eventId: 'trace-e2e-1', step: 'safety', decision: 'SAFETY_PASSED',
      confidence: 1.0, reasoning: ['all 5 safety rules passed'],
    });

    tracer.logDecision({
      eventId: 'trace-e2e-1', step: 'trust_scorer', decision: 'TRUST_APPROVED',
      confidence: 0.78, reasoning: ['score=0.78, level=medium'],
    });

    tracer.logDecision({
      eventId: 'trace-e2e-1', step: 'verifier', decision: 'VERIFICATION_PASSED',
      confidence: 0.95, reasoning: ['tsc --noEmit passed, eslint passed'],
    });

    tracer.logDecision({
      eventId: 'trace-e2e-1', step: 'pr_creation', decision: 'PR_CREATED',
      confidence: 1.0, reasoning: ['PR #42 created', 'PR url: https://github.com/test/repo/pull/42'],
    });

    tracer.endTrace('trace-e2e-1', 'completed');

    const trace = tracer.getTrace('trace-e2e-1');
    assert.strictEqual(trace.decisions.length, 10);
    assert.ok(trace.causalGraph.length >= 9);

    const why = tracer.why('trace-e2e-1');
    assert.strictEqual(why.outcome, 'PR_CREATED');
    assert.strictEqual(why.reasoningPath.length, 10);
    assert.ok(why.summary.includes('CLASSIFY_dependency'));
    assert.ok(why.summary.includes('PR_CREATED'));

    const explanation = tracer.explain('trace-e2e-1');
    assert.strictEqual(explanation.totalSteps, 10);
  });

  it('returns null for unknown eventId', () => {
    const why = tracer.why('nonexistent-event');
    assert.strictEqual(why, null);

    const trace = tracer.getTrace('nonexistent-event');
    assert.strictEqual(trace.decisions.length, 0);
  });
});
