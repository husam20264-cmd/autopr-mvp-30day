import { getDb } from '../../data/db.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export class SwitchDetector {
  constructor() {
    this.db = getDb();
  }

  recordAttempt(component, strategy, contextKey, success, confidence, durationMs) {
    this.db.prepare(`
      INSERT INTO meta_behaviors (component, strategy, context_key, total_attempts, total_successes, avg_confidence, avg_duration_ms, last_outcome, last_used)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(component, strategy) DO UPDATE SET
        total_attempts = total_attempts + 1,
        total_successes = total_successes + ?,
        avg_confidence = (avg_confidence * (total_attempts - 1) + ?) / total_attempts,
        avg_duration_ms = (avg_duration_ms * (total_attempts - 1) + ?) / total_attempts,
        last_outcome = ?,
        last_used = datetime('now')
    `).run(component, strategy, contextKey || null, success ? 1 : 0, confidence || 0, durationMs || 0, success ? 'success' : 'failure', success ? 1 : 0, confidence || 0, durationMs || 0, success ? 'success' : 'failure');
  }

  shouldSwitch(component, currentStrategy, minSamples = 5, minAccuracy = 0.6) {
    const current = this.db.prepare(
      `SELECT * FROM meta_behaviors WHERE component = ? AND strategy = ?`
    ).get(component, currentStrategy);

    if (!current || current.total_attempts < minSamples) return { shouldSwitch: false, reason: 'insufficient data' };

    const accuracy = current.total_attempts > 0 ? current.total_successes / current.total_attempts : 0;
    if (accuracy >= minAccuracy) return { shouldSwitch: false, reason: `current strategy adequate (${(accuracy * 100).toFixed(0)}%)` };

    const alternatives = this.db.prepare(`
      SELECT * FROM meta_behaviors WHERE component = ? AND strategy != ? AND total_attempts >= ?
      ORDER BY (total_successes * 1.0 / total_attempts) DESC LIMIT 3
    `).all(component, currentStrategy, Math.min(3, minSamples));

    if (alternatives.length === 0) return { shouldSwitch: false, reason: 'no alternative strategies with sufficient data' };

    const best = alternatives[0];
    const bestAccuracy = best.total_successes / best.total_attempts;

    if (bestAccuracy > accuracy + 0.1) {
      return {
        shouldSwitch: true,
        from: currentStrategy,
        to: best.strategy,
        currentAccuracy: accuracy,
        bestAccuracy,
        improvement: bestAccuracy - accuracy,
        reason: `${best.strategy} outperforms ${currentStrategy} (${(bestAccuracy * 100).toFixed(0)}% vs ${(accuracy * 100).toFixed(0)}%)`,
      };
    }

    return { shouldSwitch: false, reason: `no significantly better alternative` };
  }

  getComponentHealth(component) {
    const strategies = this.db.prepare(`
      SELECT *, (total_successes * 1.0 / total_attempts) as accuracy
      FROM meta_behaviors WHERE component = ? ORDER BY accuracy DESC
    `).all(component);

    if (strategies.length === 0) return null;

    return {
      component,
      strategies: strategies.map(s => ({
        name: s.strategy,
        attempts: s.total_attempts,
        accuracy: Math.round((s.total_successes / s.total_attempts) * 1000) / 1000,
        avgConfidence: s.avg_confidence,
        avgDuration: s.avg_duration_ms,
        lastUsed: s.last_used,
      })),
      best: strategies[0].strategy,
      worst: strategies[strategies.length - 1].strategy,
    };
  }

  getAllComponents() {
    return this.db.prepare(`
      SELECT component, COUNT(*) as strategies,
             SUM(total_attempts) as total_attempts,
             AVG(total_successes * 1.0 / total_attempts) as avg_accuracy
      FROM meta_behaviors GROUP BY component
    `).all();
  }

  autoTuneThreshold(metric, currentValue, minSamples = 10) {
    const behavior = this.db.prepare(`
      SELECT * FROM meta_behaviors WHERE component = ? AND strategy = ?
    `).get('threshold_tuning', metric);

    if (!behavior || behavior.total_attempts < minSamples) return { tuned: false, currentValue, reason: 'insufficient data' };

    const accuracy = behavior.total_successes / behavior.total_attempts;
    const adjustment = (accuracy - 0.5) * 0.1;
    const newValue = Math.max(0.1, Math.min(0.95, currentValue + adjustment));

    return {
      tuned: Math.abs(adjustment) > 0.02,
      from: currentValue,
      to: newValue,
      adjustment,
      accuracy,
      sampleSize: behavior.total_attempts,
    };
  }
}
