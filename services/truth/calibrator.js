import { getDb } from '../../data/db.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const DEFAULT_THRESHOLDS = {
  trust_reject: 0.3,
  trust_approve: 0.5,
  trust_high: 0.75,
  reasoner_veto: 0.4,
  reasoner_high: 0.7,
  memory_match: 0.7,
  global_match: 0.85,
  verifier_fail_confidence: 0.1,
};

export class Calibrator {
  constructor() {
    this.db = getDb();
  }

  getThreshold(name) {
    const cal = this.db.prepare(
      `SELECT current_value FROM truth_calibration WHERE metric = ?`
    ).get(`threshold:${name}`);
    return cal?.current_value ?? DEFAULT_THRESHOLDS[name] ?? 0.5;
  }

  calibrateAll() {
    const results = { updated: [], details: {} };

    // Calibrate trust thresholds from merge rates
    const trustAccuracy = this.db.prepare(`
      SELECT AVG(CASE WHEN outcome = 'merged' THEN 1.0 ELSE 0.0 END) as mergeRate,
             COUNT(*) as total, fix_type
      FROM truth_events
      WHERE fix_type IS NOT NULL
      GROUP BY fix_type
    `).all();

    for (const row of trustAccuracy) {
      if (row.total < 5) continue;
      const targetTrust = Math.max(0.3, Math.min(0.9, row.mergeRate));
      const metricName = `threshold:trust_${row.fixType}`;
      this.setCalibration(metricName, targetTrust, row.total);
      results.updated.push(metricName);
      results.details[metricName] = { value: targetTrust, sampleSize: row.total, mergeRate: row.mergeRate };
    }

    // Calibrate reasoner confidence from per-repo outcomes
    const repoAccuracy = this.db.prepare(`
      SELECT repo, AVG(CASE WHEN outcome = 'merged' THEN 1.0 ELSE 0.0 END) as mergeRate, COUNT(*) as total
      FROM truth_events
      GROUP BY repo HAVING total >= 3
    `).all();

    for (const row of repoAccuracy) {
      const metricName = `threshold:reasoner_repo_${row.repo.replace('/', '_')}`;
      this.setCalibration(metricName, row.mergeRate, row.total);
      results.updated.push(metricName);
    }

    // Overall accuracy
    const overall = this.db.prepare(`
      SELECT AVG(CASE WHEN outcome = 'merged' THEN 1.0 ELSE 0.0 END) as accuracy, COUNT(*) as total
      FROM truth_events
    `).get();

    if (overall.total >= 5) {
      this.setCalibration('threshold:overall_accuracy', overall.accuracy, overall.total);
      results.updated.push('threshold:overall_accuracy');
      results.details['threshold:overall_accuracy'] = { value: overall.accuracy, sampleSize: overall.total };
    }

    logger.info({ updated: results.updated.length, totalSamples: overall?.total || 0 }, 'Calibration complete');
    return results;
  }

  setCalibration(metric, value, sampleSize) {
    const existing = this.db.prepare(
      `SELECT current_value, history FROM truth_calibration WHERE metric = ?`
    ).get(metric);

    if (existing) {
      const history = JSON.parse(existing.history || '[]');
      history.push({ value, date: new Date().toISOString(), sampleSize });
      this.db.prepare(`
        UPDATE truth_calibration SET current_value = ?, sample_size = ?, history = ?, last_calibrated = datetime('now')
        WHERE metric = ?
      `).run(value, sampleSize, JSON.stringify(history.slice(-100)), metric);
    } else {
      this.db.prepare(`
        INSERT INTO truth_calibration (metric, current_value, sample_size, history)
        VALUES (?, ?, ?, ?)
      `).run(metric, value, sampleSize, JSON.stringify([{ value, date: new Date().toISOString(), sampleSize }]));
    }
  }

  getAllThresholds() {
    const calibrations = this.db.prepare(`SELECT * FROM truth_calibration WHERE metric LIKE 'threshold:%'`).all();
    const thresholds = { ...DEFAULT_THRESHOLDS };
    for (const c of calibrations) {
      const name = c.metric.replace('threshold:', '');
      thresholds[name] = c.current_value;
    }
    return thresholds;
  }

  getApplicableThresholds(repo, fixType) {
    const repoKey = `threshold:reasoner_repo_${repo.replace('/', '_')}`;
    const fixKey = `threshold:trust_${fixType}`;

    const repoCal = this.db.prepare(
      `SELECT current_value FROM truth_calibration WHERE metric = ?`
    ).get(repoKey);

    const fixCal = this.db.prepare(
      `SELECT current_value FROM truth_calibration WHERE metric = ?`
    ).get(fixKey);

    return {
      reasonerVeto: repoCal?.current_value ?? DEFAULT_THRESHOLDS.reasoner_veto,
      trustApprove: fixCal?.current_value ?? DEFAULT_THRESHOLDS.trust_approve,
      overallAccuracy: this.getThreshold('overall_accuracy'),
    };
  }
}
