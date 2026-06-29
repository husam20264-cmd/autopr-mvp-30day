import crypto from 'crypto';
import config from '../../config/default.js';
import { getDb } from '../../data/db.js';
import { getGithubApp } from '../../services/github/app.js';
import { getTruthTracker, getTruthReconciler } from '../../services/truth/index.js';
import { logger } from './index.js';
import { enqueueEvent } from '../../workers/pipeline.js';

export async function handleGitHubWebhook(req) {
  const signature = req.headers['x-hub-signature-256'];
  const eventType = req.headers['x-github-event'];
  const deliveryId = req.headers['x-github-delivery'];
  const body = req.body;

  if (!verifySignature(body, signature)) {
    throw new Error('Invalid webhook signature');
  }

  const payload = typeof body === 'string' ? JSON.parse(body) : body;
  const installationId = payload.installation?.id;
  const repoId = payload.repository?.id;
  const action = payload.action;

  logger.info({ eventType, action, installationId, deliveryId }, 'Webhook received');

  const db = getDb();

  if (eventType === 'installation' && payload.action === 'created') {
    const inst = payload.installation;
    const acct = inst.account;
    db.prepare(`INSERT OR REPLACE INTO installations (id, account_login, account_type, target_type, permission, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))`)
      .run(inst.id, acct.login, acct.type, inst.target_type, inst.permissions?.actions);
    logger.info({ installationId: inst.id, login: acct.login }, 'App installed');
    return { installed: true };
  }

  if (eventType === 'installation' && payload.action === 'deleted') {
    db.prepare(`UPDATE installations SET uninstalled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(installationId);
    logger.info({ installationId }, 'App uninstalled');
    return { uninstalled: true };
  }

  if (!repoId) return { ignored: true, reason: 'no repository' };

  const repo = payload.repository;
  db.prepare(`INSERT OR IGNORE INTO repos (id, owner, name, full_name, default_branch, installation_id)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(repo.id, repo.owner?.login || repo.owner?.name, repo.name, repo.full_name, repo.default_branch, installationId);

  // Truth ingestion: handle PR merged/closed outcomes
  if (eventType === 'pull_request' && action === 'closed') {
    return await ingestPullRequestTruth(payload, deliveryId, db);
  }

  const eventId = deliveryId;
  db.prepare(`INSERT INTO events (id, installation_id, repo_id, event_type, action, payload, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')`)
    .run(eventId, installationId, repoId, eventType, action || null, JSON.stringify(payload));

  const shouldProcess = isActionable(eventType, action, payload);
  if (shouldProcess) {
    enqueueEvent({ eventId, eventType, action, installationId, repoId, payload });
  }

  return { received: true, eventId, processed: shouldProcess };
}

function verifySignature(payload, signature) {
  if (!config.github.webhookSecret || !signature) return false;
  const sig = crypto.createHmac('sha256', config.github.webhookSecret)
    .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(`sha256=${sig}`), Buffer.from(signature));
}

function isActionable(eventType, action, payload) {
  if (eventType === 'push' && payload.ref?.startsWith('refs/heads/')) return true;
  if (eventType === 'check_run' && ['completed', 'rerequested'].includes(action)) return true;
  if (eventType === 'issues' && action === 'opened') return true;
  if (eventType === 'pull_request' && action === 'opened') return true;
  return false;
}

async function ingestPullRequestTruth(payload, eventId, db) {
  const pr = payload.pull_request;
  if (!pr) return { ignored: true, reason: 'no pull_request data' };

  const repo = payload.repository?.full_name || `${payload.repository?.owner?.login}/${payload.repository?.name}`;
  const merged = pr.merged === true;
  const outcome = merged ? 'merged' : 'closed';
  const mergedBy = pr.merged_by?.login || null;

  // Find matching eventId from our PRs table
  const existingPR = db.prepare(
    `SELECT event_id, fix_type, diff_preview FROM prs WHERE pr_number = ? AND repo_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(pr.number, payload.repository?.id);

  const truthEventId = existingPR?.event_id || eventId;
  const fixType = existingPR?.fix_type || null;
  const diffPreview = existingPR?.diff_preview || null;

  // Record ground truth
  const tracker = getTruthTracker();
  const truthId = tracker.recordTruth({
    prNumber: pr.number,
    repo,
    eventId: truthEventId,
    fixType,
    outcome,
    mergedBy,
    diffPreview,
    payload: { title: pr.title, state: pr.state, merged, merged_by: mergedBy },
  });

  // Reconcile truth across all layers
  const reconciler = getTruthReconciler();
  await reconciler.reconcile({
    prNumber: pr.number,
    repo,
    fixType,
    outcome,
    eventId: truthEventId,
    diffPreview,
    contextSnapshot: null,
  });

  logger.info({ prNumber: pr.number, repo, outcome, mergedBy, truthId }, 'Truth ingested from PR close');
  return { truth_recorded: true, truthId, outcome };
}
