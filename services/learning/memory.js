import crypto from 'crypto';
import pino from 'pino';
import { getDb } from '../../data/db.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export class PatternMemory {
  constructor() {
    this.db = getDb();
  }

  hashPattern(fixType, filePaths, context, global = false) {
    const normalized = {
      fixType,
      files: global ? [] : filePaths.sort(),
      keyContext: global ? {} : this.extractKeyContext(context),
    };
    return crypto.createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex')
      .slice(0, 16);
  }

  extractKeyContext(context) {
    if (!context) return {};
    const deps = context.fileContents?.['package.json'];
    const ciFile = Object.keys(context.fileContents || {})
      .find(f => f.includes('.yml') || f.includes('.yaml'));
    return {
      hasPackageJson: !!deps,
      hasCI: !!ciFile,
      languageHint: context.language || '',
    };
  }

  recordPattern(fixType, diff, context, accepted = true) {
    if (!diff) return;

    const filePaths = this.extractFilePaths(diff);
    const patternHash = this.hashPattern(fixType, filePaths, context);
    const existing = this.db.prepare(`SELECT * FROM patterns WHERE pattern_hash = ?`).get(patternHash);

    if (existing) {
      const repoList = JSON.parse(existing.repos || '[]');
      if (!repoList.includes(context.repo)) repoList.push(context.repo);

      this.db.prepare(`
        UPDATE patterns SET
          times_used = times_used + 1,
          times_accepted = times_accepted + ?,
          confidence = (CAST(times_accepted AS REAL) + ?) / (CAST(times_used AS REAL) + 1),
          last_used = datetime('now'),
          repos = ?
        WHERE pattern_hash = ?
      `).run(accepted ? 1 : 0, accepted ? 1 : 0, JSON.stringify(repoList), patternHash);

      // Promote to global when accepted in 3+ distinct repos with >= 80% confidence
      const updated = this.db.prepare(`SELECT * FROM patterns WHERE pattern_hash = ?`).get(patternHash);
      const uniqueRepos = new Set(JSON.parse(updated.repos || '[]'));
      if (uniqueRepos.size >= 3 && updated.confidence >= 0.8 && !updated.global) {
        const globalHash = this.hashPattern(fixType, [], {}, true);
        this.db.prepare(`
          INSERT OR IGNORE INTO patterns (fix_type, pattern_hash, pattern_data, diff_template, confidence, times_used, times_accepted, repos, global)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(
          fixType,
          globalHash,
          JSON.stringify({ files: [], keyContext: {}, global: true }),
          existing.diff_template,
          updated.confidence,
          updated.times_used,
          updated.times_accepted,
          '[]',
        );
        logger.info({ patternHash, globalHash, fixType, repos: uniqueRepos.size }, 'Pattern promoted to global');
      }
    } else {
      this.db.prepare(`
        INSERT INTO patterns (fix_type, pattern_hash, pattern_data, file_pattern, diff_template, confidence, times_used, times_accepted, repos)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, json_array(?))
      `).run(
        fixType,
        patternHash,
        JSON.stringify({ files: filePaths, keyContext: this.extractKeyContext(context) }),
        filePaths.join(','),
        this.createDiffTemplate(diff),
        accepted ? 1 : 0,
        accepted ? 1 : 0,
        context.repo || 'unknown',
      );
    }

    logger.info({ patternHash, fixType, accepted, reposCount: existing ? JSON.parse(existing.repos || '[]').length : 1 }, 'Pattern recorded');
  }

  recordRejection(repo, fixType, reason, diff, context) {
    this.db.prepare(`
      INSERT INTO rejections (repo, fix_type, reason, diff_preview, context_snapshot)
      VALUES (?, ?, ?, ?, ?)
    `).run(repo, fixType, reason, (diff || '').slice(0, 500), JSON.stringify({
      files: this.extractFilePaths(diff),
      keyContext: this.extractKeyContext(context),
    }));

    this.db.prepare(`
      UPDATE patterns SET times_rejected = times_rejected + 1
      WHERE pattern_hash IN (
        SELECT DISTINCT pattern_hash FROM patterns
        WHERE fix_type = ? AND file_pattern = ?
      )
    `).run(fixType, this.extractFilePaths(diff).join(','));

    logger.info({ repo, fixType, reason }, 'Rejection recorded');
  }

  findMatch(fixType, context) {
    const filePaths = Object.keys(context.fileContents || {});
    const patternHash = this.hashPattern(fixType, filePaths, context);
    const globalHash = this.hashPattern(fixType, [], {}, true);

    // Check both per-repo and global caches
    const cached = this.db.prepare(`
      SELECT * FROM memory_cache WHERE (cache_key = ? OR cache_key = ?) AND confidence >= 0.7
      ORDER BY confidence DESC LIMIT 1
    `).get(patternHash, globalHash);

    if (cached) {
      this.db.prepare(`UPDATE memory_cache SET hit_count = hit_count + 1, last_hit = datetime('now') WHERE id = ?`)
        .run(cached.id);
      logger.info({ patternHash, cacheKey: cached.cache_key }, 'Cache hit — skipping LLM');
      return {
        match: true,
        diff: cached.diff,
        confidence: cached.confidence,
        source: 'cache',
      };
    }

    const highConfPatterns = this.db.prepare(`
      SELECT * FROM patterns
      WHERE fix_type = ? AND confidence >= 0.7
      ORDER BY global DESC, confidence DESC, times_accepted DESC
      LIMIT 10
    `).all(fixType);

    for (const pattern of highConfPatterns) {
      const patternData = JSON.parse(pattern.pattern_data || '{}');
      const matchScore = this.calculateMatchScore(patternData, context, filePaths);

      if (matchScore >= 0.7 && pattern.diff_template) {
        const diff = this.applyTemplate(pattern.diff_template, context, matchScore);
        if (diff) {
          const cacheConfidence = pattern.confidence * matchScore;
          this.db.prepare(`
            INSERT OR REPLACE INTO memory_cache (cache_key, fix_type, diff, confidence)
            VALUES (?, ?, ?, ?)
          `).run(patternHash, fixType, diff, cacheConfidence);
          if (patternHash !== globalHash) {
            this.db.prepare(`
              INSERT OR REPLACE INTO memory_cache (cache_key, fix_type, diff, confidence)
              VALUES (?, ?, ?, ?)
            `).run(globalHash, fixType, diff, cacheConfidence);
          }

          logger.info({ patternHash, patternId: pattern.id, matchScore }, 'Pattern match found — skipping LLM');
          return {
            match: true,
            diff,
            confidence: pattern.confidence * matchScore,
            source: 'pattern',
            patternId: pattern.id,
          };
        }
      }
    }

    return { match: false };
  }

  calculateMatchScore(patternData, context, currentFiles) {
    if (!patternData) return 0;

    // Global patterns match any repo (only fixType must match)
    if (patternData.global || !patternData.files || patternData.files.length === 0) {
      return 0.85;
    }

    let score = 0;
    const patternFiles = new Set(patternData.files);
    const currentSet = new Set(currentFiles);

    const intersection = [...patternFiles].filter(f => [...currentSet].some(c => c.includes(f) || f.includes(c)));
    score += (intersection.length / Math.max(patternFiles.size, 1)) * 0.5;

    if (patternData.keyContext?.hasPackageJson && context.fileContents?.['package.json']) {
      score += 0.2;
    }
    if (patternData.keyContext?.hasCI && Object.keys(context.fileContents || {}).some(f => f.includes('.yml') || f.includes('.yaml'))) {
      score += 0.2;
    }
    if (patternData.keyContext?.languageHint && context.language === patternData.keyContext.languageHint) {
      score += 0.1;
    }

    return Math.min(1, score);
  }

  createDiffTemplate(diff) {
    if (!diff) return '';
    const lines = diff.split('\n');
    return lines.map(line => {
      if (line.startsWith('@@')) return line.replace(/-?\d+/g, '{OFFSET}');
      return line;
    }).join('\n');
  }

  applyTemplate(template, context, confidence) {
    if (!template) return null;
    let result = template.replace(/\{OFFSET\}/g, '1');
    if (result.includes('{REPO}')) result = result.replace(/\{REPO\}/g, context.repo || 'unknown');
    return result;
  }

  extractFilePaths(diff) {
    if (!diff) return [];
    const paths = new Set();
    for (const line of diff.split('\n')) {
      const m = line.match(/^(?:--- a\/|\+\+\+ b\/)(.+)/);
      if (m) paths.add(m[1]);
    }
    return [...paths];
  }

  getStats() {
    const patterns = this.db.prepare(`SELECT COUNT(*) as count FROM patterns`).get();
    const highConf = this.db.prepare(`SELECT COUNT(*) as count FROM patterns WHERE confidence >= 0.7`).get();
    const totalUsed = this.db.prepare(`SELECT SUM(times_used) as total FROM patterns`).get();
    const totalAccepted = this.db.prepare(`SELECT SUM(times_accepted) as total FROM patterns`).get();
    const rejections = this.db.prepare(`SELECT COUNT(*) as count FROM rejections`).get();
    const cacheHits = this.db.prepare(`SELECT SUM(hit_count) as total FROM memory_cache`).get();
    const globalPatterns = this.db.prepare(`SELECT COUNT(*) as count FROM patterns WHERE global = 1`).get();

    return {
      totalPatterns: patterns.count,
      highConfidencePatterns: highConf.count,
      globalPatterns: globalPatterns.count,
      totalUses: totalUsed.total || 0,
      totalAccepted: totalAccepted.total || 0,
      overallAcceptanceRate: totalUsed.total > 0
        ? Math.round((totalAccepted.total / totalUsed.total) * 100)
        : 0,
      totalRejections: rejections.count,
      totalCacheHits: cacheHits.total || 0,
    };
  }

  getTopPatterns(limit = 10) {
    return this.db.prepare(`
      SELECT * FROM patterns ORDER BY global DESC, confidence DESC, times_accepted DESC LIMIT ?
    `).all(limit).map(p => ({
      ...p,
      pattern_data: JSON.parse(p.pattern_data || '{}'),
      repos: JSON.parse(p.repos || '[]'),
    }));
  }

  getRecentRejections(limit = 10) {
    return this.db.prepare(`
      SELECT * FROM rejections ORDER BY created_at DESC LIMIT ?
    `).all(limit);
  }
}
