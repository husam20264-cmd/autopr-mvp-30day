import { getDb } from '../../data/db.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export class TruthTracker {
  constructor() {
    this.db = getDb();
  }

  recordTruth({ prNumber, repo, eventId, fixType, outcome, mergedBy, confidenceAtTime, trustScoreAtTime, diffPreview, payload }) {
    const { lastInsertRowid } = this.db.prepare(`
      INSERT INTO truth_events (pr_number, repo, event_id, fix_type, outcome, merged_by, confidence_at_time, trust_score_at_time, diff_preview, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(prNumber, repo, eventId || null, fixType || null, outcome, mergedBy || null,
      confidenceAtTime || null, trustScoreAtTime || null, diffPreview || null,
      JSON.stringify(payload || {}));

    logger.info({ prNumber, repo, outcome, fixType }, 'Truth recorded');
    return lastInsertRowid;
  }

  getTruthForPR(prNumber, repo) {
    return this.db.prepare(`
      SELECT * FROM truth_events WHERE pr_number = ? AND repo = ? ORDER BY created_at DESC LIMIT 1
    `).get(prNumber, repo);
  }

  getOutcomeRate(repo, fixType, days = 30) {
    const results = this.db.prepare(`
      SELECT outcome, COUNT(*) as count FROM truth_events
      WHERE repo = ? AND fix_type = ? AND observed_at >= datetime('now', ?)
      GROUP BY outcome
    `).all(repo, fixType, `-${days} days`);

    const total = results.reduce((s, r) => s + r.count, 0);
    if (total === 0) return { mergeRate: 0, closeRate: 0, total: 0 };

    const merged = results.find(r => r.outcome === 'merged')?.count || 0;
    const closed = results.find(r => r.outcome === 'closed')?.count || 0;

    return {
      total,
      merged,
      closed,
      mergeRate: merged / total,
      closeRate: closed / total,
    };
  }

  getAllTruth(fixType, limit = 100) {
    if (fixType) {
      return this.db.prepare(`
        SELECT * FROM truth_events WHERE fix_type = ? ORDER BY observed_at DESC LIMIT ?
      `).all(fixType, limit);
    }
    return this.db.prepare(`SELECT * FROM truth_events ORDER BY observed_at DESC LIMIT ?`).all(limit);
  }

  getTruthByDateRange(fromDate, toDate) {
    return this.db.prepare(`
      SELECT * FROM truth_events WHERE observed_at >= ? AND observed_at <= ? ORDER BY observed_at ASC
    `).all(fromDate, toDate);
  }

  getAccuracyByFixType(days = 30) {
    const results = this.db.prepare(`
      SELECT fix_type, outcome, COUNT(*) as count FROM truth_events
      WHERE observed_at >= datetime('now', ?) AND fix_type IS NOT NULL
      GROUP BY fix_type, outcome
    `).all(`-${days} days`);

    const byType = {};
    for (const r of results) {
      if (!byType[r.fix_type]) byType[r.fix_type] = { total: 0, merged: 0, closed: 0 };
      byType[r.fix_type].total += r.count;
      if (r.outcome === 'merged') byType[r.fix_type].merged += r.count;
      if (r.outcome === 'closed') byType[r.fix_type].closed += r.count;
    }

    return Object.entries(byType).map(([fixType, data]) => ({
      fixType,
      total: data.total,
      merged: data.merged,
      closed: data.closed,
      accuracy: data.total > 0 ? data.merged / data.total : 0,
    }));
  }
}
