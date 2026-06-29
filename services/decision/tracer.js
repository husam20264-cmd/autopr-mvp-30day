import { getDb } from '../../data/db.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export class DecisionTracer {
  constructor() {
    this.db = getDb();
    this.activeChain = new Map();
  }

  startTrace(eventId, initialContext = {}) {
    const { lastInsertRowid } = this.db.prepare(`
      INSERT INTO decision_logs (event_id, step, decision, input_snapshot, output_snapshot)
      VALUES (?, 'trace_root', 'pipeline_started', ?, ?)
    `).run(eventId, JSON.stringify(initialContext), JSON.stringify({ status: 'started' }));

    this.activeChain.set(eventId, lastInsertRowid);
    return lastInsertRowid;
  }

  logDecision({
    eventId,
    step,
    parentId,
    decision,
    confidence = 1.0,
    reasoning = [],
    alternatives = [],
    input = {},
    output = {},
    durationMs = 0,
    status = 'completed',
  }) {
    const parent = parentId || this.activeChain.get(eventId);
    if (!parent) {
      logger.warn({ eventId, step }, 'No active trace — creating root');
      this.startTrace(eventId, input);
      return this.logDecision({ eventId, step, decision, confidence, reasoning, alternatives, input, output, durationMs, status });
    }

    const { lastInsertRowid } = this.db.prepare(`
      INSERT INTO decision_logs (event_id, step, parent_id, decision, confidence, reasoning_chain, input_snapshot, output_snapshot, duration_ms, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId, step, parent, decision, confidence,
      JSON.stringify(reasoning),
      JSON.stringify(input),
      JSON.stringify(output),
      durationMs, status,
    );

    this.db.prepare(`
      INSERT INTO causal_edges (from_decision_id, to_decision_id, relation, rationale)
      VALUES (?, ?, 'led_to', ?)
    `).run(parent, lastInsertRowid, `${step}: ${decision}`);

    for (const alt of alternatives) {
      this.db.prepare(`
        INSERT INTO decision_alternatives (decision_id, alternative, reason_rejected, score)
        VALUES (?, ?, ?, ?)
      `).run(lastInsertRowid, alt.alternative, alt.reasonRejected, alt.score || 0);
    }

    this.activeChain.set(eventId, lastInsertRowid);
    logger.info({ eventId, step, decision, confidence }, 'Decision logged');
    return lastInsertRowid;
  }

  endTrace(eventId, finalStatus = 'completed') {
    const lastId = this.activeChain.get(eventId);
    if (lastId) {
      this.db.prepare(`UPDATE decision_logs SET output_snapshot = json_set(output_snapshot, '$.status', ?) WHERE id = ?`)
        .run(finalStatus, lastId);
      this.activeChain.delete(eventId);
    }
  }

  getTrace(eventId) {
    const decisions = this.db.prepare(`
      SELECT * FROM decision_logs WHERE event_id = ? ORDER BY id ASC
    `).all(eventId);

    const edges = this.db.prepare(`
      SELECT ce.*, dl_from.step AS from_step, dl_from.decision AS from_decision,
             dl_to.step AS to_step, dl_to.decision AS to_decision
      FROM causal_edges ce
      JOIN decision_logs dl_from ON dl_from.id = ce.from_decision_id
      JOIN decision_logs dl_to ON dl_to.id = ce.to_decision_id
      WHERE dl_from.event_id = ? OR dl_to.event_id = ?
    `).all(eventId, eventId);

    return {
      eventId,
      decisions: decisions.map(d => ({
        ...d,
        reasoning_chain: JSON.parse(d.reasoning_chain || '[]'),
        input_snapshot: JSON.parse(d.input_snapshot || '{}'),
        output_snapshot: JSON.parse(d.output_snapshot || '{}'),
      })),
      causalGraph: edges.map(e => ({
        from: { step: e.from_step, decision: e.from_decision },
        to: { step: e.to_step, decision: e.to_decision },
        relation: e.relation,
        rationale: e.rationale,
      })),
    };
  }

  getAlternatives(decisionId) {
    return this.db.prepare(`
      SELECT * FROM decision_alternatives WHERE decision_id = ?
    `).all(decisionId);
  }

  explain(eventId) {
    const trace = this.getTrace(eventId);
    const explanation = [];

    for (const d of trace.decisions) {
      const altCount = this.db.prepare(
        `SELECT COUNT(*) as count FROM decision_alternatives WHERE decision_id = ?`
      ).get(d.id).count;

      explanation.push({
        step: d.step,
        decision: d.decision,
        confidence: d.confidence,
        why: d.reasoning_chain,
        alternativesRejected: altCount,
        duration: d.duration_ms,
        status: d.status,
      });
    }

    return {
      eventId,
      totalSteps: explanation.length,
      chain: explanation,
      graph: trace.causalGraph,
    };
  }

  why(eventId) {
    const trace = this.getTrace(eventId);
    if (!trace.decisions.length) return null;

    const outcome = trace.decisions[trace.decisions.length - 1];
    const path = [];

    for (const d of trace.decisions) {
      const alts = this.getAlternatives(d.id);
      path.push({
        what: `${d.step}: ${d.decision}`,
        confidence: d.confidence,
        reasoning: d.reasoning_chain,
        alternativesConsidered: alts.map(a => ({
          alternative: a.alternative,
          rejectedBecause: a.reason_rejected,
          score: a.score,
        })),
      });
    }

    return {
      eventId,
      outcome: outcome.decision,
      finalConfidence: outcome.confidence,
      reasoningPath: path,
      summary: path.map(p => p.what).join(' → '),
    };
  }

  getPipelineInsights(eventId) {
    const trace = this.getTrace(eventId);
    if (!trace.decisions.length) return null;

    const totalDuration = trace.decisions.reduce((s, d) => s + (d.duration_ms || 0), 0);
    const failedSteps = trace.decisions.filter(d => d.status === 'failed');
    const allAlternatives = [];

    for (const d of trace.decisions) {
      allAlternatives.push(...this.getAlternatives(d.id));
    }

    return {
      eventId,
      duration: totalDuration,
      steps: trace.decisions.length,
      decisionCount: trace.decisions.filter(d => d.step !== 'trace_root').length,
      firstDecision: trace.decisions[0],
      lastDecision: outcome => trace.decisions[trace.decisions.length - 1],
      slowestStep: trace.decisions.reduce((a, b) => (a.duration_ms > b.duration_ms ? a : b), { duration_ms: 0 }),
      failedSteps,
      alternativesConsidered: allAlternatives.length,
      bottlenecks: trace.decisions.filter(d => d.duration_ms > 5000).map(d => `${d.step}: ${d.decision} (${d.duration_ms}ms)`),
    };
  }
}
