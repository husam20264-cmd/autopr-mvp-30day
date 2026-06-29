import 'dotenv/config';
import pino from 'pino';
import config from '../config/default.js';
import { getDb } from '../data/db.js';
import { discoverRepos } from '../services/discovery/crawler.js';
import { scoreRepo, isTargetRepo, persistScoredRepo } from '../services/scoring/engine.js';
import { getGithubApp } from '../services/github/app.js';
import { logger } from '../api/webhooks/index.js';

logger.info('AutoPR Scorer Worker started');

const octokit = getGithubApp();

export async function runDiscoveryCycle(maxResults = 50) {
  logger.info({ maxResults }, 'Starting discovery cycle');
  const result = await discoverRepos(maxResults);
  logger.info({ result }, 'Discovery cycle complete');
  return result;
}

export async function rescoreExistingRepos() {
  const db = getDb();
  const repos = db.prepare(`SELECT * FROM repos`).all();
  let rescored = 0;

  for (const repo of repos) {
    try {
      const { data } = await octokit.rest.repos.get({
        owner: repo.owner,
        repo: repo.name,
      });
      data.has_ci = true;
      const scored = scoreRepo(data);
      if (isTargetRepo(scored)) {
        persistScoredRepo(scored);
        rescored++;
      }
    } catch {
      // Repo may no longer exist
    }
  }

  logger.info({ total: repos.length, rescored }, 'Rescore complete');
  return { total: repos.length, rescored };
}

async function cycle() {
  await runDiscoveryCycle(50);
  await rescoreExistingRepos();
}

setInterval(cycle, 3600000); // Every hour
