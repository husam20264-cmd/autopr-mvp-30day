import { getDb } from '../../data/db.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const ADJUSTMENT_RATE = 0.05;

export class RuleMutator {
  constructor() {
    this.db = getDb();
  }

  defineRule(name, ruleType, condition, action, priority = 0) {
    this.db.prepare(`
      INSERT INTO meta_rules (name, rule_type, condition, action, priority)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET condition = ?, action = ?, priority = ?
    `).run(name, ruleType, condition, action, priority, condition, action, priority);
    logger.info({ name, ruleType }, 'Rule defined');
  }

  recordFiring(name, correct) {
    const existing = this.db.prepare(`SELECT * FROM meta_rules WHERE name = ?`).get(name);
    if (!existing) return;

    const newTimesFired = existing.times_fired + 1;
    const newTimesCorrect = existing.times_correct + (correct ? 1 : 0);
    const newRate = newTimesCorrect / newTimesFired;

    this.db.prepare(`
      UPDATE meta_rules SET
        times_fired = ?, times_correct = ?, success_rate = ?,
        sample_size = ?, last_fired = datetime('now')
      WHERE name = ?
    `).run(newTimesFired, newTimesCorrect, newRate, newTimesFired, name);
  }

  mutate(name) {
    const rule = this.db.prepare(`SELECT * FROM meta_rules WHERE name = ?`).get(name);
    if (!rule) return null;

    const history = JSON.parse(rule.mutation_history || '[]');
    const rate = rule.times_fired > 0 ? rule.times_correct / rule.times_fired : 0;

    if (rule.times_fired < 5) return { mutated: false, reason: 'insufficient samples', rate };

    let newCondition = rule.condition;
    let newPriority = rule.priority;
    let mutationType = null;

    // If success rate is very low, relax the condition or lower priority
    if (rate < 0.3) {
      mutationType = 'relax_threshold';
      newCondition = rule.condition.replace(/([<>]=?\s*)(\d+\.?\d*)/g, (match, op, val) => {
        const num = parseFloat(val);
        return op === '>=' ? `>= ${(num * 0.8).toFixed(2)}` :
               op === '>' ? `> ${(num * 0.8).toFixed(2)}` :
               op === '<=' ? `<= ${(num * 1.2).toFixed(2)}` :
               op === '<' ? `< ${(num * 1.2).toFixed(2)}` : match;
      });
      newPriority = Math.max(0, rule.priority - 1);
    }
    // If success rate is high, strengthen the rule
    else if (rate > 0.85 && rule.times_fired >= 10) {
      mutationType = 'strengthen_threshold';
      newCondition = rule.condition.replace(/([<>]=?\s*)(\d+\.?\d*)/g, (match, op, val) => {
        const num = parseFloat(val);
        return op === '>=' ? `>= ${(num * 1.15).toFixed(2)}` :
               op === '>' ? `> ${(num * 1.15).toFixed(2)}` :
               op === '<=' ? `<= ${(num * 0.85).toFixed(2)}` :
               op === '<' ? `< ${(num * 0.85).toFixed(2)}` : match;
      });
      newPriority = rule.priority + 1;
    }

    if (!mutationType) return { mutated: false, reason: 'rate within acceptable range', rate };

    history.push({
      date: new Date().toISOString(),
      from: { condition: rule.condition, priority: rule.priority },
      to: { condition: newCondition, priority: newPriority },
      reason: mutationType,
      rateBefore: rate,
    });

    this.db.prepare(`
      UPDATE meta_rules SET condition = ?, priority = ?, mutation_history = ?,
        last_mutated = datetime('now'), success_rate = ?
      WHERE name = ?
    `).run(newCondition, newPriority, JSON.stringify(history), rate, name);

    logger.info({ name, mutationType, rateBefore: rate }, 'Rule mutated');
    return { mutated: true, mutationType, from: { condition: rule.condition, priority: rule.priority }, to: { condition: newCondition, priority: newPriority }, rate };
  }

  mutateAll() {
    const rules = this.db.prepare(`SELECT * FROM meta_rules WHERE active = 1`).all();
    const results = [];
    for (const rule of rules) {
      const result = this.mutate(rule.name);
      if (result) results.push({ name: rule.name, ...result });
    }
    return results;
  }

  getActiveRules() {
    return this.db.prepare(`SELECT *, (times_correct * 1.0 / NULLIF(times_fired, 0)) as rate FROM meta_rules WHERE active = 1 ORDER BY priority DESC`).all();
  }

  getDeadRules(daysWithoutFiring = 30) {
    return this.db.prepare(`
      SELECT * FROM meta_rules WHERE last_fired IS NULL OR last_fired <= datetime('now', ?)
    `).all(`-${daysWithoutFiring} days`);
  }

  archiveDeadRules(daysWithoutFiring = 30) {
    const dead = this.getDeadRules(daysWithoutFiring);
    for (const rule of dead) {
      this.db.prepare(`UPDATE meta_rules SET active = 0 WHERE name = ?`).run(rule.name);
      logger.info({ name: rule.name }, 'Dead rule archived');
    }
    return dead.length;
  }
}
