import { getDb } from '../../data/db.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export class TrapDetector {
  constructor() {
    this.db = getDb();
  }

  defineTrap(name, trapType, triggerCondition, failureSignature, severity = 'medium') {
    this.db.prepare(`
      INSERT INTO meta_trap_patterns (name, trap_type, trigger_condition, failure_signature, severity)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET trigger_condition = ?, failure_signature = ?, severity = ?
    `).run(name, trapType, triggerCondition, failureSignature, severity, triggerCondition, failureSignature, severity);
    logger.info({ name, trapType, severity }, 'Trap pattern defined');
  }

  check(eventId, fixType, context) {
    const traps = this.db.prepare(`
      SELECT * FROM meta_trap_patterns WHERE severity IN ('high', 'medium')
    `).all();

    const triggered = [];

    for (const trap of traps) {
      const condition = trap.trigger_condition;

      // Check fix-type based traps
      if (condition.includes(`fixType=${fixType}`)) {
        triggered.push({ trap, match: 'fix_type', severity: trap.severity });
        continue;
      }

      // Check file-based traps
      if (condition.startsWith('filePattern=')) {
        const filePattern = condition.replace('filePattern=', '');
        const files = context.relevantFiles || Object.keys(context.fileContents || {});
        if (files.some(f => f.includes(filePattern) || new RegExp(filePattern.replace(/\*/g, '.*')).test(f))) {
          triggered.push({ trap, match: `file:${filePattern}`, severity: trap.severity });
          continue;
        }
      }

      // Check diff-size traps
      if (condition.startsWith('diffSize>')) {
        const limit = parseInt(condition.replace('diffSize>', ''));
        if ((context.diff?.length || 0) > limit) {
          triggered.push({ trap, match: `diffSize>${limit}`, severity: trap.severity });
          continue;
        }
      }

      // Check repo pattern traps
      if (condition.startsWith('repoHas=')) {
        const repoPattern = condition.replace('repoHas=', '');
        if ((context.repo || '').includes(repoPattern)) {
          triggered.push({ trap, match: `repo:${repoPattern}`, severity: trap.severity });
          continue;
        }
      }

      // Check consecutive failures
      if (condition.startsWith('consecutiveFailures>')) {
        const limit = parseInt(condition.replace('consecutiveFailures>', ''));
        const recent = this.db.prepare(`
          SELECT COUNT(*) as failures FROM (
            SELECT outcome FROM truth_events WHERE repo = ? AND fix_type = ?
            ORDER BY observed_at DESC LIMIT ?
          ) WHERE outcome = 'closed'
        `).get(context.repo, fixType, limit);
        if (recent.failures >= limit) {
          triggered.push({ trap, match: `consecutiveFailures>${limit}`, severity: trap.severity });
          continue;
        }
      }
    }

    // Record triggers
    for (const t of triggered) {
      this.db.prepare(`
        UPDATE meta_trap_patterns SET times_triggered = times_triggered + 1, last_hit = datetime('now')
        WHERE id = ?
      `).run(t.trap.id);
    }

    const highSeverity = triggered.filter(t => t.severity === 'high');
    const mediumSeverity = triggered.filter(t => t.severity === 'medium');

    if (highSeverity.length > 0) {
      logger.warn({ eventId, traps: highSeverity.map(t => t.trap.name) }, 'High-severity traps triggered — blocking');
    }

    return {
      blocked: highSeverity.length > 0,
      warnings: mediumSeverity.map(t => t.trap.name),
      triggered: triggered.map(t => ({ name: t.trap.name, match: t.match, severity: t.severity })),
      reason: highSeverity.length > 0
        ? `Blocked by traps: ${highSeverity.map(t => t.trap.name).join(', ')}`
        : null,
    };
  }

  recordAvoidance(name) {
    this.db.prepare(`
      UPDATE meta_trap_patterns SET times_avoided = times_avoided + 1 WHERE name = ?
    `).run(name);
  }

  learnFromRejection(eventId, fixType, repo, reason, context) {
    const existing = this.db.prepare(
      `SELECT * FROM meta_trap_patterns WHERE name = ?`
    ).get(`auto_${fixType}_${repo.replace('/', '_')}`);

    if (!existing) {
      this.defineTrap(
        `auto_${fixType}_${repo.replace('/', '_')}`,
        'auto_learned',
        `fixType=${fixType}`,
        `rejection_reason:${reason?.slice(0, 100)}`,
        'low',
      );
      logger.info({ fixType, repo, reason }, 'Auto-learned trap from rejection');
    }
  }

  getTrapsBySeverity(severity) {
    return this.db.prepare(`SELECT * FROM meta_trap_patterns WHERE severity = ? ORDER BY times_triggered DESC`).all(severity);
  }

  getAllTraps() {
    return this.db.prepare(`SELECT * FROM meta_trap_patterns ORDER BY severity DESC, times_triggered DESC`).all();
  }

  getTrapSummary() {
    const traps = this.getAllTraps();
    return {
      total: traps.length,
      high: traps.filter(t => t.severity === 'high').length,
      medium: traps.filter(t => t.severity === 'medium').length,
      low: traps.filter(t => t.severity === 'low').length,
      totalTriggers: traps.reduce((s, t) => s + t.times_triggered, 0),
      totalAvoidances: traps.reduce((s, t) => s + t.times_avoided, 0),
      topTraps: traps.filter(t => t.times_triggered > 0).sort((a, b) => b.times_triggered - a.times_triggered).slice(0, 5),
    };
  }
}
