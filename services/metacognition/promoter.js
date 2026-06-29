import { getDb } from '../../data/db.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const PROMOTION_THRESHOLD = {
  minRepos: 3,
  minConfidence: 0.8,
  minSamples: 10,
  minAcceptanceRate: 0.75,
};

export class PolicyPromoter {
  constructor() {
    this.db = getDb();
  }

  evaluatePatternsForPromotion() {
    const promoted = [];

    // 1. Check pattern memory for global-ready patterns
    const patterns = this.db.prepare(`
      SELECT * FROM patterns
      WHERE confidence >= ? AND times_used >= ? AND global = 0
    `).all(PROMOTION_THRESHOLD.minConfidence, PROMOTION_THRESHOLD.minSamples);

    for (const p of patterns) {
      const repos = JSON.parse(p.repos || '[]');
      if (repos.length >= PROMOTION_THRESHOLD.minRepos) {
        const acceptanceRate = p.times_used > 0 ? p.times_accepted / p.times_used : 0;
        if (acceptanceRate >= PROMOTION_THRESHOLD.minAcceptanceRate) {
          this.promoteToPolicy(p);
          promoted.push({ name: p.pattern_hash, type: 'memory_pattern', fixType: p.fix_type });
        }
      }
    }

    // 2. Check trust signals that consistently predict success
    const trustSignals = this.db.prepare(`
      SELECT te.fix_type, te.trust_score_at_time,
             AVG(CASE WHEN te.outcome = 'merged' THEN 1.0 ELSE 0.0 END) as mergeRate,
             COUNT(*) as total
      FROM truth_events te
      WHERE te.trust_score_at_time IS NOT NULL AND te.fix_type IS NOT NULL
      GROUP BY te.fix_type, ROUND(te.trust_score_at_time, 1)
      HAVING total >= 5 AND mergeRate >= 0.8
    `).all();

    for (const signal of trustSignals) {
      const policyName = `trust_${signal.fix_type}_${(signal.trust_score_at_time * 100).toFixed(0)}`;
      this.db.prepare(`
        INSERT INTO meta_policies (name, source_pattern, condition, action, confidence, repos_observed, times_validated)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET times_validated = times_validated + 1, last_verified = datetime('now')
      `).run(
        policyName,
        `trust_signal:${signal.fix_type}`,
        `fixType=${signal.fix_type} AND trustScore>=${signal.trust_score_at_time.toFixed(2)}`,
        `auto_approve`,
        signal.mergeRate,
        signal.total,
        signal.total,
      );
      promoted.push({ name: policyName, type: 'trust_signal', fixType: signal.fix_type });
    }

    if (promoted.length > 0) {
      logger.info({ count: promoted.length, details: promoted }, 'Patterns promoted to policies');
    }
    return promoted;
  }

  promoteToPolicy(pattern) {
    const repos = JSON.parse(pattern.repos || '[]');
    const acceptanceRate = pattern.times_used > 0 ? pattern.times_accepted / pattern.times_used : 0;

    const policyName = `pattern_${pattern.pattern_hash}`;
    this.db.prepare(`
      INSERT INTO meta_policies (name, source_pattern, condition, action, confidence, repos_observed, times_validated)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET confidence = ?, repos_observed = ?, times_validated = times_validated + 1, last_verified = datetime('now')
    `).run(
      policyName,
      `memory_pattern:${pattern.fix_type}:${pattern.pattern_hash}`,
      `fixType=${pattern.fix_type} AND filePattern=${pattern.file_pattern || '*'}`,
      `apply_cached_diff`,
      acceptanceRate,
      repos.length,
      pattern.times_used,
      acceptanceRate,
      repos.length,
    );

    // Mark as global in pattern memory
    this.db.prepare(`UPDATE patterns SET global = 1 WHERE id = ?`).run(pattern.id);
    logger.info({ patternHash: pattern.pattern_hash, policyName, acceptanceRate }, 'Pattern promoted to policy');
  }

  checkPolicy(fixType, context) {
    const policies = this.db.prepare(`
      SELECT * FROM meta_policies WHERE active = 1 AND condition LIKE ?
    `).all(`%fixType=${fixType}%`);

    for (const policy of policies) {
      const trustMatch = policy.condition.match(/trustScore>=([\d.]+)/);
      if (trustMatch && context.trustScore >= parseFloat(trustMatch[1])) {
        return { matched: true, policy, action: policy.action, confidence: policy.confidence };
      }

      const fileMatch = policy.condition.match(/filePattern=([\w*]+)/);
      if (fileMatch) {
        const pattern = fileMatch[1].replace(/\*/g, '.*');
        const files = context.relevantFiles || [];
        if (files.some(f => new RegExp(pattern).test(f))) {
          return { matched: true, policy, action: policy.action, confidence: policy.confidence };
        }
      }
    }

    return { matched: false };
  }

  getActivePolicies() {
    return this.db.prepare(`SELECT * FROM meta_policies WHERE active = 1 ORDER BY confidence DESC`).all();
  }

  verifyPolicies() {
    const policies = this.getActivePolicies();
    const now = new Date().toISOString();
    let verified = 0;

    for (const p of policies) {
      const recent = this.db.prepare(`
        SELECT outcome FROM truth_events
        WHERE fix_type = ? AND observed_at >= datetime('now', '-30 days')
        ORDER BY observed_at DESC LIMIT 10
      `).all(p.source_pattern.includes(':') ? p.source_pattern.split(':')[1] : '');

      if (recent.length >= 3) {
        const recentRate = recent.filter(r => r.outcome === 'merged').length / recent.length;
        if (recentRate < 0.6) {
          this.db.prepare(`UPDATE meta_policies SET active = 0, last_verified = ? WHERE id = ?`).run(now, p.id);
          logger.info({ policy: p.name, recentRate }, 'Policy deactivated — accuracy dropped');
        } else {
          this.db.prepare(`UPDATE meta_policies SET last_verified = ? WHERE id = ?`).run(now, p.id);
          verified++;
        }
      }
    }
    return { verified, deactivated: policies.length - verified };
  }
}
