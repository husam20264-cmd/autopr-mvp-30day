import { getGithubApp } from '../github/app.js';
import { SEARCH_QUERIES } from '../scoring/queries.js';
import { scoreRepo, isTargetRepo, persistScoredRepo } from '../scoring/engine.js';
import { getDb } from '../../data/db.js';
import { trackEvent } from '../analytics/index.js';
import { logger } from '../../api/webhooks/index.js';

export async function discoverRepos(maxResults = 50) {
  const octokit = getGithubApp();
  const discovered = [];
  const resultsPerQuery = Math.ceil(maxResults / SEARCH_QUERIES.length);

  for (const sq of SEARCH_QUERIES) {
    try {
      const { data } = await octokit.rest.search.repos({
        q: sq.query,
        sort: sq.sort,
        per_page: resultsPerQuery,
      });

      for (const item of data.items) {
        item.has_ci = sq.id.includes('ci');
        discovered.push(item);
      }

      logger.info({ query: sq.id, count: data.items.length }, 'Search executed');
    } catch (err) {
      logger.error({ err, query: sq.id }, 'Search query failed');
    }
  }

  const scored = discovered.map(scoreRepo).sort((a, b) => b.score - a.score);
  const targets = scored.filter(isTargetRepo);

  for (const t of targets.slice(0, maxResults)) {
    persistScoredRepo(t);
  }

  logger.info({
    discovered: discovered.length,
    scored: scored.length,
    targets: targets.length,
  }, 'Discovery complete');

  trackEvent('discovery_run', 1, {
    discovered: discovered.length,
    targets: targets.length,
  });

  return { discovered: discovered.length, targets: targets.slice(0, maxResults) };
}

export async function getDiscoveredRepos({ minScore = 7, limit = 20 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT r.*, a.value as score, a.metadata
    FROM repos r
    JOIN analytics a ON a.metadata LIKE '%' || r.full_name || '%'
    WHERE a.metric = 'repo_scored' AND a.value >= ?
    ORDER BY a.value DESC
    LIMIT ?
  `).all(minScore, limit).map(row => ({
    ...row,
    score: row.score,
    metadata: JSON.parse(row.metadata || '{}'),
  }));
}
