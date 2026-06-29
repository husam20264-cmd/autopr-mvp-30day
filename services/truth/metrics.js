import { getDb } from '../../data/db.js';

export class TruthMetrics {
  constructor() {
    this.db = getDb();
  }

  getAccuracy(days = 30) {
    const results = this.db.prepare(`
      SELECT SUM(total) as total, SUM(correct) as correct, SUM(incorrect) as incorrect,
             fix_type
      FROM accuracy_metrics
      WHERE date >= datetime('now', ?)
      GROUP BY fix_type
    `).all(`-${days} days`);

    return results.map(r => ({
      fixType: r.fix_type,
      total: r.total,
      correct: r.correct,
      incorrect: r.incorrect,
      accuracy: r.total > 0 ? r.correct / r.total : 0,
    }));
  }

  getPrecisionRecall(days = 30) {
    const truth = this.db.prepare(`
      SELECT outcome, fix_type, COUNT(*) as count
      FROM truth_events
      WHERE observed_at >= datetime('now', ?) AND fix_type IS NOT NULL
      GROUP BY outcome, fix_type
    `).all(`-${days} days`);

    const byType = {};
    for (const r of truth) {
      if (!byType[r.fix_type]) byType[r.fix_type] = { TP: 0, FP: 0, FN: 0 };
      if (r.outcome === 'merged') byType[r.fix_type].TP = r.count;
      else byType[r.fix_type].FP = r.count;
    }

    return Object.entries(byType).map(([fixType, { TP, FP, FN }]) => ({
      fixType,
      truePositives: TP,
      falsePositives: FP,
      falseNegatives: FN,
      precision: TP + FP > 0 ? TP / (TP + FP) : 0,
      recall: TP + FN > 0 ? TP / (TP + FN) : 0,
      f1Score: TP + FP + FN > 0 ? 2 * TP / (2 * TP + FP + FN) : 0,
    }));
  }

  getTrend(days = 90) {
    const daily = this.db.prepare(`
      SELECT date, SUM(total) as total, SUM(correct) as correct,
             SUM(correct) * 1.0 / SUM(total) as accuracy
      FROM accuracy_metrics
      WHERE date >= datetime('now', ?)
      GROUP BY date ORDER BY date ASC
    `).all(`-${days} days`);

    return daily.map(d => ({
      date: d.date,
      total: d.total,
      correct: d.correct,
      accuracy: Math.round(d.accuracy * 1000) / 1000,
    }));
  }

  getSummary() {
    const overall = this.db.prepare(`
      SELECT SUM(total) as totalPRs, SUM(correct) as merged,
             AVG(CASE WHEN total > 0 THEN correct * 1.0 / total END) as avgAccuracy
      FROM accuracy_metrics
    `).get();

    const byFixType = this.getAccuracy(30);
    const topFixTypes = byFixType.sort((a, b) => b.total - a.total).slice(0, 5);

    return {
      totalPRsTracked: overall?.totalPRs || 0,
      mergedPRs: overall?.merged || 0,
      overallAccuracy: overall?.avgAccuracy || 0,
      topFixTypes,
    };
  }
}
