import { getDb } from '../../data/db.js';
import { getAggregateMetric, getDailyMetric } from '../../services/analytics/index.js';

export function generateFirst100Report() {
  const db = getDb();

  const reposScored = getAggregateMetric('repo_scored', 30);
  const pipelinesStarted = getAggregateMetric('pipeline_started', 30);
  const pipelinesCompleted = getAggregateMetric('pipeline_completed', 30);
  const prsCreated = getAggregateMetric('pr_created', 30);
  const gtmRuns = getAggregateMetric('gtm_daily_run', 30);
  const gtmPRs = getAggregateMetric('gtm_pr_created', 30);

  const prsByType = {
    dependency: getAggregateMetric('pr_dependency', 30),
    lint: getAggregateMetric('pr_lint', 30),
    ci_failure: getAggregateMetric('pr_ci_failure', 30),
    trivial_bug: getAggregateMetric('pr_trivial_bug', 30),
  };

  const targetRepos = db.prepare(`
    SELECT DISTINCT r.full_name
    FROM repos r
    JOIN analytics a ON a.metadata LIKE '%' || r.full_name || '%'
    WHERE a.metric = 'repo_scored' AND a.value >= 7
    ORDER BY a.value DESC
  `).all().length;

  const pipelineHealth = {
    started: pipelinesStarted,
    completed: pipelinesCompleted,
    completionRate: pipelinesStarted > 0
      ? Math.round((pipelinesCompleted / pipelinesStarted) * 100)
      : 0,
    prRate: pipelinesStarted > 0
      ? Math.round((prsCreated / pipelinesStarted) * 100)
      : 0,
  };

  const dailyTrends = getDailyMetric('gtm_pr_created', 14);

  const report = `
═══════════════════════════════════════════
  AutoPR — First 100 Repos Report
═══════════════════════════════════════════

📊 OVERVIEW
────────────
Target repos discovered:  ${targetRepos}
GTM playbook runs:         ${gtmRuns}
Value PRs sent:            ${gtmPRs}

🔬 PIPELINE HEALTH
───────────────────
Pipelines started:      ${pipelineHealth.started}
Pipelines completed:    ${pipelineHealth.completed}
Completion rate:        ${pipelineHealth.completionRate}%
PR creation rate:       ${pipelineHealth.prRate}%

📦 PRs BY FIX TYPE
──────────────────
Dependency updates:   ${prsByType.dependency}
Lint/formatting:      ${prsByType.lint}
CI fixes:             ${prsByType.ci_failure}
Trivial bugs:         ${prsByType.trivial_bug}
Total:                ${Object.values(prsByType).reduce((a, b) => a + b, 0)}

📈 DAILY VALUE PR TREND
────────────────────────
${dailyTrends.map(d => `  ${d.date}: ${d.total} PRs`).join('\n')}

🧠 KEY INSIGHTS
───────────────
${pipelineHealth.prRate < 50 ? '⚠️  Low PR creation rate — check classifier + context builder' : '✅ Healthy pipeline conversion'}
${prsByType.dependency > prsByType.lint + prsByType.ci_failure ? '💡 Dependency fixes dominate — focus targeting on dep-heavy repos' : ''}
${gtmPRs < 10 ? '⚠️  Need more daily volume — run discovery more aggressively' : '✅ Good volume'}

🎯 NEXT ACTIONS
───────────────
1. ${prsByType.dependency === 0 ? 'Enable dependency fix type — highest acceptance potential' : 'Continue dependency targeting'}
2. ${pipelineHealth.completionRate < 80 ? 'Fix pipeline failures — check event processing' : 'Optimize PR acceptance rate'}
3. Track PR acceptance manually this week
`;

  return report;
}

if (process.argv[1]?.includes('generateReport.js')) {
  console.log(generateFirst100Report());
}
