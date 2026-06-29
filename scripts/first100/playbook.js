import 'dotenv/config';
import { getDb } from '../../data/db.js';
import { getGithubApp } from '../../services/github/app.js';
import { getInstallationOctokit } from '../../services/github/app.js';
import { classifyEvent } from '../../services/classifier/index.js';
import { buildContext } from '../../services/context/index.js';
import { generatePatch } from '../../services/ai/generate.js';
import { safetyCheck } from '../../services/safety/index.js';
import { createPR } from '../../services/pr-creator/index.js';
import { discoverRepos, getDiscoveredRepos } from '../../services/discovery/crawler.js';
import { trackEvent } from '../../services/analytics/index.js';
import { logger } from '../../api/webhooks/index.js';

const DAILY_TARGET = 5;

export async function executeDailyPlaybook() {
  logger.info({ target: DAILY_TARGET }, 'Starting daily GTM playbook');

  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  // Get repos scored today
  const todaysRepos = db.prepare(`
    SELECT DISTINCT r.* FROM repos r
    JOIN analytics a ON a.metadata LIKE '%' || r.full_name || '%'
    WHERE a.metric = 'repo_scored' AND a.date = ?
    ORDER BY a.value DESC
    LIMIT ?
  `).all(today, DAILY_TARGET);

  if (todaysRepos.length < DAILY_TARGET) {
    logger.info({ found: todaysRepos.length, needed: DAILY_TARGET }, 'Not enough repos, running discovery');
    await discoverRepos(50);
  }

  const targets = await getDiscoveredRepos({ limit: DAILY_TARGET });

  const results = [];
  for (const repo of targets) {
    try {
      const result = await generateValuePR(repo);
      results.push(result);
    } catch (err) {
      logger.error({ err, repo: repo.full_name }, 'Failed to generate PR for repo');
      results.push({ repo: repo.full_name, status: 'failed', error: err.message });
    }
  }

  const summary = {
    date: today,
    attempted: results.length,
    successful: results.filter(r => r.status === 'created').length,
    failed: results.filter(r => r.status === 'failed').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    results,
  };

  trackEvent('gtm_daily_run', 1, summary);
  logger.info(summary, 'Daily playbook complete');
  return summary;
}

async function generateValuePR(repo) {
  logger.info({ repo: repo.full_name }, 'Generating value PR');

  const octokit = getGithubApp();

  // Check if repo already has PRs from us
  const db = getDb();
  const existingPR = db.prepare(`SELECT pr_url FROM prs WHERE pr_url LIKE ? LIMIT 1`)
    .get(`%${repo.full_name}%`);
  if (existingPR) {
    return { repo: repo.full_name, status: 'skipped', reason: 'Already has AutoPR' };
  }

  // Fetch repo details
  const { data: repoData } = await octokit.rest.repos.get({
    owner: repo.owner,
    repo: repo.name,
  });

  // Try to find an actionable event (recent issues, CI failures)
  const action = await findActionableIssue(octokit, repo.owner, repo.name);
  if (!action) {
    return { repo: repo.full_name, status: 'skipped', reason: 'No actionable issue found' };
  }

  // Classify
  const fixType = classifyEvent(action.eventType, action.action, action.payload);
  if (!fixType) {
    return { repo: repo.full_name, status: 'skipped', reason: 'Could not classify' };
  }

  // Attempt to find/use an installation
  const install = db.prepare(`SELECT id FROM installations WHERE account_login = ?`).get(repo.owner);
  if (!install) {
    return { repo: repo.full_name, status: 'skipped', reason: 'No installation' };
  }

  const installationOctokit = await getInstallationOctokit(install.id);
  const context = await buildContext(installationOctokit, repo.owner, repo.name, fixType, action.payload);

  const diff = await generatePatch(fixType, context);
  if (!diff) {
    return { repo: repo.full_name, status: 'skipped', reason: 'No patch generated' };
  }

  const safety = safetyCheck(diff, { repo: repo.name });
  if (!safety.safe) {
    return { repo: repo.full_name, status: 'skipped', reason: `Safety: ${safety.reason}` };
  }

  const pr = await createPR(installationOctokit, context, fixType, diff);

  trackEvent('gtm_pr_created', 1, {
    repo: repo.full_name,
    fixType,
    prNumber: pr.number,
  });

  return {
    repo: repo.full_name,
    status: 'created',
    fixType,
    prNumber: pr.number,
    prUrl: pr.html_url,
  };
}

async function findActionableIssue(octokit, owner, repo) {
  // 1. Look for failing CI
  try {
    const { data: checks } = await octokit.rest.checks.listSuitesForRef({
      owner, repo, ref: 'main',
    });
    const failing = checks.check_suites?.find(cs => cs.conclusion === 'failure');
    if (failing) {
      const { data: checkRuns } = await octokit.rest.checks.listForSuite({
        owner, repo, check_suite_id: failing.id,
      });
      const failed = checkRuns.check_runs?.find(cr => cr.conclusion === 'failure');
      if (failed) {
        return {
          eventType: 'check_run',
          action: 'completed',
          payload: {
            repository: { owner: { login: owner }, name: repo, full_name: `${owner}/${repo}` },
            check_run: { id: failed.id, conclusion: 'failure', name: failed.name },
          },
        };
      }
    }
  } catch {}

  // 2. Look for open issues with fixable patterns
  try {
    const { data: issues } = await octokit.rest.issues.listForRepo({
      owner, repo, state: 'open', labels: 'bug', per_page: 5,
    });
    for (const issue of issues) {
      if (classifyEvent('issues', 'opened', { issue })) {
        return {
          eventType: 'issues',
          action: 'opened',
          payload: {
            repository: { owner: { login: owner }, name: repo, full_name: `${owner}/${repo}` },
            issue,
          },
        };
      }
    }
  } catch {}

  return null;
}
