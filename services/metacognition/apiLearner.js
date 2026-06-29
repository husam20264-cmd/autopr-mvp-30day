import crypto from 'crypto';
import { getDb } from '../../data/db.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const VALID_STRATEGIES = ['direct_edit', 'dependency_bump', 'config_change', 'lint_fix', 'template_apply'];

export class ApiLearner {
  constructor() {
    this.db = getDb();
  }

  hashContext(repoLanguage, fixType, filePattern) {
    return crypto.createHash('md5').update(`${repoLanguage}:${fixType}:${filePattern}`).digest('hex').slice(0, 16);
  }

  recordStrategyOutcome(repoLanguage, fixType, filePattern, strategy, success) {
    const contextHash = this.hashContext(repoLanguage, fixType, filePattern);

    this.db.prepare(`
      INSERT INTO meta_api_strategies (context_hash, repo_language, fix_type, file_pattern, strategy, confidence, sample_size, times_selected, times_successful, last_used)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, datetime('now'))
      ON CONFLICT(context_hash) DO UPDATE SET
        sample_size = sample_size + 1,
        times_selected = times_selected + 1,
        times_successful = times_successful + ?,
        confidence = (times_successful * 1.0 / sample_size),
        last_used = datetime('now'),
        strategy = ?
    `).run(contextHash, repoLanguage || null, fixType, filePattern || null, strategy, success ? 1 : 0.3, success ? 1 : 0, success ? 1 : 0, strategy);
  }

  selectBestStrategy(repoLanguage, fixType, filePattern) {
    const contextHash = this.hashContext(repoLanguage, fixType, filePattern);

    const exact = this.db.prepare(`
      SELECT * FROM meta_api_strategies WHERE context_hash = ? AND sample_size >= 3
      ORDER BY confidence DESC LIMIT 1
    `).get(contextHash);

    if (exact) return { strategy: exact.strategy, confidence: exact.confidence, source: 'exact_match' };

    const similar = this.db.prepare(`
      SELECT strategy, AVG(confidence) as avgConf, SUM(sample_size) as totalSamples
      FROM meta_api_strategies
      WHERE fix_type = ? AND sample_size >= 2
      GROUP BY strategy
      ORDER BY avgConf DESC LIMIT 1
    `).get(fixType);

    if (similar && similar.totalSamples >= 3) {
      return { strategy: similar.strategy, confidence: similar.avgConf, source: 'fix_type_match' };
    }

    return { strategy: 'direct_edit', confidence: 0.5, source: 'default' };
  }

  getContextInsights(repoLanguage, fixType) {
    const strategies = this.db.prepare(`
      SELECT strategy, confidence, sample_size, times_selected, times_successful
      FROM meta_api_strategies
      WHERE repo_language = ? AND fix_type = ? AND sample_size >= 2
      ORDER BY confidence DESC
    `).all(repoLanguage, fixType);

    if (strategies.length === 0) return null;

    return {
      repoLanguage,
      fixType,
      recommended: strategies[0].strategy,
      strategies: strategies.map(s => ({
        name: s.strategy,
        confidence: s.confidence,
        samples: s.sample_size,
        successRate: s.times_selected > 0 ? (s.times_successful / s.times_selected) : 0,
      })),
    };
  }

  getAllLearnedStrategies() {
    return this.db.prepare(`
      SELECT context_hash, repo_language, fix_type, file_pattern, strategy, confidence, sample_size
      FROM meta_api_strategies WHERE sample_size >= 2
      ORDER BY confidence DESC LIMIT 50
    `).all();
  }
}
