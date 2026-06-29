import { getDb } from '../../data/db.js';

const WEIGHTS = {
  stars: { weight: 1.5, idealRange: [50, 2000] },
  activity30d: { weight: 3.0, min: 3 },
  hasCI: { weight: 2.0 },
  openIssues: { weight: 2.0, min: 3 },
  language: { weight: 1.0, preferred: ['JavaScript', 'TypeScript', 'Python'] },
  recentPRs: { weight: 1.5, min: 2 },
  hasDeps: { weight: 1.0 },
  freshness: { weight: 1.5, maxDays: 90 },
};

export function scoreRepo(repo) {
  let score = 0;
  const breakdown = {};

  // Stars: prefer small-mid repos
  if (repo.stargazers_count >= WEIGHTS.stars.idealRange[0] &&
      repo.stargazers_count <= WEIGHTS.stars.idealRange[1]) {
    score += WEIGHTS.stars.weight * 2;
    breakdown.stars = 'ideal';
  } else if (repo.stargazers_count < WEIGHTS.stars.idealRange[0]) {
    score += WEIGHTS.stars.weight * 0.5;
    breakdown.stars = 'small';
  } else {
    score += WEIGHTS.stars.weight * 0.3;
    breakdown.stars = 'large';
  }

  // Activity in last 30 days
  const pushed = repo.pushed_at ? (Date.now() - new Date(repo.pushed_at).getTime()) / 86400000 : 999;
  if (pushed <= 30) {
    score += WEIGHTS.activity30d.weight;
    breakdown.activity = 'active';
  } else if (pushed <= 90) {
    score += WEIGHTS.activity30d.weight * 0.5;
    breakdown.activity = 'stale';
  } else {
    breakdown.activity = 'inactive';
  }

  // CI presence (has .github/workflows or ci config)
  if (repo.has_ci || repo.topics?.some(t => ['ci', 'github-actions'].includes(t))) {
    score += WEIGHTS.hasCI.weight;
    breakdown.hasCI = true;
  } else {
    breakdown.hasCI = false;
  }

  // Open issues (pain signal)
  const issues = repo.open_issues_count || 0;
  if (issues >= WEIGHTS.openIssues.min && issues <= 50) {
    score += WEIGHTS.openIssues.weight;
    breakdown.issues = 'healthy';
  } else if (issues > 50) {
    score += WEIGHTS.openIssues.weight * 0.5;
    breakdown.issues = 'high';
  } else {
    breakdown.issues = 'low';
  }

  // Language preference
  const lang = repo.language || '';
  if (WEIGHTS.language.preferred.includes(lang)) {
    score += WEIGHTS.language.weight * 2;
    breakdown.language = 'preferred';
  } else if (lang) {
    score += WEIGHTS.language.weight * 0.5;
    breakdown.language = 'other';
  } else {
    breakdown.language = 'unknown';
  }

  // Freshness (repo age)
  const created = repo.created_at ? (Date.now() - new Date(repo.created_at).getTime()) / 86400000 : 999;
  if (created <= WEIGHTS.freshness.maxDays) {
    score += WEIGHTS.freshness.weight;
    breakdown.freshness = 'new';
  } else if (created <= 365) {
    score += WEIGHTS.freshness.weight * 0.7;
    breakdown.freshness = 'medium';
  } else {
    breakdown.freshness = 'old';
  }

  // NOT archived
  if (repo.archived) {
    score = 0;
    breakdown.archived = true;
  }

  return { score: Math.round(score * 10) / 10, breakdown, repo };
}

export function isTargetRepo(scored) {
  return scored.score >= 7 && !scored.breakdown.archived;
}

export function persistScoredRepo(scored) {
  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO repos (id, owner, name, full_name, default_branch, installation_id, score, language, stars, topics, scored_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(
      scored.repo.id,
      scored.repo.owner?.login || scored.repo.owner?.name || 'unknown',
      scored.repo.name,
      scored.repo.full_name,
      scored.repo.default_branch || 'main',
      0,
      scored.score,
      scored.repo.language || '',
      scored.repo.stargazers_count || 0,
      (scored.repo.topics || []).join(','),
    );
  trackScoredRepo(scored);
}

function trackScoredRepo(scored) {
  const db = getDb();
  const date = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO analytics (date, metric, value, metadata) VALUES (?, ?, ?, ?)`)
    .run(date, 'repo_scored', scored.score, JSON.stringify({
      repo: scored.repo.full_name,
      breakdown: scored.breakdown,
      target: isTargetRepo(scored),
    }));
}
