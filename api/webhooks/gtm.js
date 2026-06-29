import { getDb } from '../../data/db.js';
import { getAggregateMetric, getDailyMetric } from '../../services/analytics/index.js';
import { getDiscoveredRepos } from '../../services/discovery/crawler.js';

export async function handleGTMRequest(req, res) {
  const db = getDb();

  const targetRepos = await getDiscoveredRepos({ limit: 100 });

  const gtmPRsCreated = getAggregateMetric('gtm_pr_created', 30);
  const gtmRuns = getAggregateMetric('gtm_daily_run', 30);
  const gtmPRsDaily = getDailyMetric('gtm_pr_created', 14);

  const installs = db.prepare(`SELECT COUNT(*) as count FROM installations WHERE uninstalled_at IS NULL`).get();
  const activeRepos = db.prepare(`SELECT COUNT(*) as count FROM repos`).get();
  const prsCreated = db.prepare(`SELECT COUNT(*) as count FROM prs WHERE status = 'opened'`).get();
  const prsByType = db.prepare(`SELECT fix_type, COUNT(*) as count FROM prs GROUP BY fix_type`).all();

  const pipelineMetrics = {
    started: getAggregateMetric('pipeline_started', 30),
    completed: getAggregateMetric('pipeline_completed', 30),
    skipped: getAggregateMetric('pipeline_skipped', 30),
    rejected: getAggregateMetric('pipeline_safety_rejected', 30),
  };

  const today = new Date().toISOString().slice(0, 10);
  const todayPRs = db.prepare(`
    SELECT COUNT(*) as count FROM analytics
    WHERE metric = 'gtm_pr_created' AND date = ?
  `).get(today);

  res.json({
    date: today,
    todayPRs: todayPRs.count,
    totals: {
      targetRepos: targetRepos.length,
      gtmPRsCreated,
      gtmRuns,
      installs: installs.count,
      activeRepos: activeRepos.count,
      prsCreated: prsCreated.count,
      prsByType: Object.fromEntries(prsByType.map(p => [p.fix_type, p.count])),
    },
    pipelineHealth: {
      ...pipelineMetrics,
      completionRate: pipelineMetrics.started > 0
        ? Math.round((pipelineMetrics.completed / pipelineMetrics.started) * 100)
        : 0,
      rejectionRate: pipelineMetrics.started > 0
        ? Math.round((pipelineMetrics.rejected / pipelineMetrics.started) * 100)
        : 0,
    },
    dailyTrend: gtmPRsDaily.map(d => ({ date: d.date, prs: d.total })),
    recentTargets: targetRepos.slice(0, 10).map(r => ({
      repo: r.full_name,
      score: r.score,
      language: r.metadata?.breakdown?.language,
    })),
  });
}
