import { getInstallationOctokit } from '../services/github/app.js';
import { classifyEvent } from '../services/classifier/index.js';
import { buildContext } from '../services/context/index.js';
import { generatePatch } from '../services/ai/generate.js';
import { safetyCheck } from '../services/safety/index.js';
import { createPR } from '../services/pr-creator/index.js';
import { checkLimit, incrementUsage } from '../services/billing/index.js';
import { trackEvent } from '../services/analytics/index.js';
import { getDb } from '../data/db.js';
import { PR_STATES } from '../config/constants.js';
import { buildTrustContext, prepareTrustedPR } from '../services/trust/index.js';
import { tryMemoryFirst, learnFromOutcome, getLearningSystem } from '../services/learning/index.js';
import { DeterministicVerifier } from '../services/verifier/index.js';
import { getReasoner, getIngestor, getGraph } from '../services/knowledge/index.js';
import { getTracer } from '../services/decision/index.js';
import { getTrapDetector, getSwitchDetector, getApiLearner, getRuleMutator, runMetaCognitionCycle } from '../services/metacognition/index.js';
import { logger } from '../api/webhooks/index.js';

const eventQueue = [];

export function enqueueEvent(event) {
  eventQueue.push(event);
  processNext();
}

async function processNext() {
  if (eventQueue.length === 0) return;
  const event = eventQueue.shift();
  try {
    await runPipeline(event);
  } catch (err) {
    logger.error({ err, eventId: event.eventId }, 'Pipeline failed');
  }
}

export async function runPipeline(event) {
  const { eventId, eventType, action, installationId, repoId, payload } = event;
  const db = getDb();
  const startTime = Date.now();
  const tracer = getTracer();

  logger.info({ eventId, fixType: null }, 'Pipeline started');
  db.prepare(`UPDATE events SET status = 'processing' WHERE id = ?`).run(eventId);
  trackEvent('pipeline_started');

  tracer.startTrace(eventId, { eventType, action, installationId, repoId });

  // Step 1: Classify
  {
    const t0 = Date.now();
    const fixType = classifyEvent(eventType, action, payload);
    if (!fixType) {
      const reasoning = [`eventType=${eventType}`, `action=${action}`, 'fixType=null — not actionable'];
      tracer.logDecision({ eventId, step: 'classifier', decision: 'SKIP', reasoning, input: { eventType, action }, durationMs: Date.now() - t0 });
      logger.info({ eventId }, 'No actionable fix type found');
      db.prepare(`UPDATE events SET status = 'skipped' WHERE id = ?`).run(eventId);
      trackEvent('pipeline_skipped');
      tracer.endTrace(eventId, 'skipped');
      return;
    }
    const reasoning = [`eventType=${eventType}`, `action=${action}`, `classified as ${fixType}`];
    tracer.logDecision({ eventId, step: 'classifier', decision: `CLASSIFY_${fixType}`, confidence: 0.85, reasoning, alternatives: [
      { alternative: 'skip (no fix)', reasonRejected: 'event is actionable', score: 0.15 },
    ], input: { eventType, action }, output: { fixType }, durationMs: Date.now() - t0 });
    db.prepare(`UPDATE events SET status = ? WHERE id = ?`).run(`classifying_${fixType}`, eventId);
    trackEvent(`classified_${fixType}`);
  }

  // Step 2: Check billing limits
  {
    const t0 = Date.now();
    const limit = checkLimit(installationId);
    if (!limit.allowed) {
      const reasoning = [`installationId=${installationId}`, `reason=${limit.reason}`, 'billing limit reached'];
      tracer.logDecision({ eventId, step: 'billing', decision: 'LIMIT_REACHED', reasoning, alternatives: [
        { alternative: 'proceed anyway', reasonRejected: 'usage cap exceeded', score: 0 },
      ], input: { installationId }, output: { reason: limit.reason }, durationMs: Date.now() - t0 });
      logger.warn({ eventId, reason: limit.reason }, 'Billing limit reached');
      db.prepare(`UPDATE events SET status = 'limit_reached' WHERE id = ?`).run(eventId);
      trackEvent('pipeline_limit_reached');
      tracer.endTrace(eventId, 'limit_reached');
      return;
    }
    tracer.logDecision({ eventId, step: 'billing', decision: 'LIMIT_OK', confidence: 1.0, reasoning: ['usage within free tier'], durationMs: Date.now() - t0 });
    trackEvent('pipeline_limit_passed');
  }

  const octokit = await getInstallationOctokit(installationId);
  const owner = payload.repository?.owner?.login || payload.repository?.owner?.name;
  const repo = payload.repository?.name;

  // Step 3: Knowledge reasoning (check graph before building context)
  const reasoner = getReasoner();
  const ingestor = getIngestor();
  const repoLabel = `${owner}/${repo}`;
  ingestor.ingestEvent(eventType, payload, repoLabel);

  {
    const t0 = Date.now();
    const reasonerResult = reasoner.shouldFix(owner, repo, fixType, payload.issue?.body || payload.check_run?.name);
    if (!reasonerResult.should) {
      const reasoning = [`repo=${repoLabel}`, `confidence=${reasonerResult.confidence}`, `reason=${reasonerResult.reason}`];
      tracer.logDecision({ eventId, step: 'knowledge_reasoner', decision: 'VETO', confidence: reasonerResult.confidence, reasoning, alternatives: [
        { alternative: 'proceed with fix', reasonRejected: reasonerResult.reason, score: reasonerResult.confidence },
      ], input: { owner, repo, fixType }, output: { reason: reasonerResult.reason }, durationMs: Date.now() - t0 });
      logger.info({ eventId, reason: reasonerResult.reason, confidence: reasonerResult.confidence }, 'Reasoner vetoed fix');
      db.prepare(`UPDATE events SET status = 'reasoner_vetoed' WHERE id = ?`).run(eventId);
      trackEvent('pipeline_reasoner_vetoed', 1, { confidence: reasonerResult.confidence, reason: reasonerResult.reason });
      tracer.endTrace(eventId, 'vetoed');
      return;
    }
    const reasoning = [`repo=${repoLabel}`, `confidence=${reasonerResult.confidence}`, 'fix worth attempting'];
    tracer.logDecision({ eventId, step: 'knowledge_reasoner', decision: 'PROCEED', confidence: reasonerResult.confidence, reasoning, input: { owner, repo, fixType }, output: { confidence: reasonerResult.confidence }, durationMs: Date.now() - t0 });
    trackEvent('pipeline_reasoner_passed', 1, { confidence: reasonerResult.confidence });
  }

  // Pre-flight trap detection
  {
    const trapDetector = getTrapDetector();
    const trapResult = trapDetector.check(eventId, fixType, { repo: repoLabel, diff: null, relevantFiles: [], fileContents: {} });
    if (trapResult.blocked) {
      logger.warn({ eventId, traps: trapResult.triggered }, 'Pre-flight trap check blocked execution');
      db.prepare(`UPDATE events SET status = 'trap_blocked' WHERE id = ?`).run(eventId);
      trackEvent('pipeline_trap_blocked');
      tracer.logDecision({ eventId, step: 'trap_detector', decision: 'BLOCKED', reasoning: trapResult.triggered.map(t => `${t.name} (${t.severity})`) });
      tracer.endTrace(eventId, 'trap_blocked');
      return;
    }
    tracer.logDecision({ eventId, step: 'trap_detector', decision: 'CLEAR', reasoning: ['no traps triggered'] });
  }

  // Step 4: Build context
  {
    const t0 = Date.now();
    const context = await buildContext(octokit, owner, repo, fixType, payload);
    tracer.logDecision({ eventId, step: 'context', decision: 'CONTEXT_READY', confidence: 1.0, reasoning: [`fetched ${Object.keys(context.fileContents || {}).length} files`, `branch=${context.defaultBranch}`], output: { filesCount: Object.keys(context.fileContents || {}).length, defaultBranch: context.defaultBranch }, durationMs: Date.now() - t0 });
    db.prepare(`UPDATE events SET status = 'context_ready' WHERE id = ?`).run(eventId);
    trackEvent('context_built');
  }

  // Step 5: Try memory first (bypass LLM if pattern matches)
  const memoryResult = await tryMemoryFirst(fixType, context);
  let diff;
  let memorySource = null;

  if (memoryResult.match) {
    diff = memoryResult.diff;
    memorySource = memoryResult.source;
    const reasoning = [`source=${memoryResult.source}`, `confidence=${memoryResult.confidence}`, 'LLM bypassed — 0 tokens consumed'];
    tracer.logDecision({ eventId, step: 'memory_lookup', decision: 'MEMORY_HIT', confidence: memoryResult.confidence, reasoning, alternatives: [
      { alternative: 'call LLM', reasonRejected: 'pattern match found with sufficient confidence', score: memoryResult.confidence },
    ], input: { fixType }, output: { source: memoryResult.source, confidence: memoryResult.confidence }, durationMs: 0 });
    logger.info({ eventId, source: memoryResult.source, confidence: memoryResult.confidence }, 'Memory hit');
    trackEvent('memory_hit', 1, { source: memoryResult.source, confidence: memoryResult.confidence });
  } else {
    const t0 = Date.now();
    diff = await generatePatch(fixType, context);
    const reasoning = ['no pattern match found', 'falling back to LLM generation'];
    tracer.logDecision({ eventId, step: 'memory_lookup', decision: 'MEMORY_MISS', confidence: 0.3, reasoning, alternatives: [
      { alternative: 'skip PR', reasonRejected: 'fix is actionable', score: 0.2 },
    ], input: { fixType }, output: { generated: !!diff }, durationMs: Date.now() - t0 });
    trackEvent('memory_miss', 1, { fixType });
  }

  if (!diff) {
    const reasoning = ['patch generation returned null — no viable fix'];
    tracer.logDecision({ eventId, step: 'patch_generation', decision: 'NO_PATCH', reasoning, output: { diff: null }, durationMs: 0 });
    logger.info({ eventId }, 'No patch generated');
    db.prepare(`UPDATE events SET status = 'no_patch' WHERE id = ?`).run(eventId);
    trackEvent('pipeline_no_patch');
    tracer.endTrace(eventId, 'no_patch');
    return;
  }
  db.prepare(`UPDATE events SET status = 'patch_generated' WHERE id = ?`).run(eventId);
  trackEvent('patch_generated');

  // Step 6: Safety check
  {
    const t0 = Date.now();
    const safety = safetyCheck(diff, context);
    if (!safety.safe) {
      const reasoning = [`reason=${safety.reason}`];
      tracer.logDecision({ eventId, step: 'safety', decision: 'SAFETY_REJECTED', reasoning, alternatives: [
        { alternative: 'override and proceed', reasonRejected: safety.reason, score: 0 },
      ], input: { diffSize: diff?.length }, output: { reason: safety.reason }, durationMs: Date.now() - t0 });
      logger.warn({ eventId, reason: safety.reason }, 'Safety check failed');
      db.prepare(`UPDATE events SET status = 'safety_rejected' WHERE id = ?`).run(eventId);
      trackEvent('pipeline_safety_rejected');
      tracer.endTrace(eventId, 'safety_rejected');
      return;
    }
    tracer.logDecision({ eventId, step: 'safety', decision: 'SAFETY_PASSED', confidence: 1.0, reasoning: ['all safety rules passed', `diff size ${diff.length} chars`], input: { diffSize: diff?.length }, durationMs: Date.now() - t0 });
    db.prepare(`UPDATE events SET status = 'safety_passed' WHERE id = ?`).run(eventId);
    trackEvent('pipeline_safety_passed');
  }

  // Step 7: Trust scoring + PR body generation
  {
    const t0 = Date.now();
    const db2 = getDb();
    const prevPRs = db2.prepare(`SELECT status FROM prs WHERE repo_id = ?`).all(repoId);
    const prevAccepted = prevPRs.filter(p => p.status === 'opened').length;
    const prevTotal = prevPRs.length;

    const trustCtx = buildTrustContext({
      repo: `${owner}/${repo}`,
      repoStars: payload.repository?.stargazers_count || 0,
      openIssues: payload.repository?.open_issues_count || 0,
      hasCI: true,
      previousAcceptedPRs: prevAccepted,
      previousTotalPRs: prevTotal,
      hoursSinceLastPR: 48,
      relevantFiles: Object.keys(context.fileContents || {}),
      diff,
    });

    const trusted = prepareTrustedPR(trustCtx, diff, fixType);

    if (!trusted) {
      const reasoning = ['trust score below threshold (< 0.5)', `repo=${owner}/${repo}`];
      tracer.logDecision({ eventId, step: 'trust_scorer', decision: 'TRUST_REJECTED', confidence: trustCtx?.score || 0.2, reasoning, alternatives: [
        { alternative: 'proceed with warning label', reasonRejected: 'too risky for unattended PR', score: trustCtx?.score || 0.2 },
      ], input: { diffSize: diff.length, fixType }, durationMs: Date.now() - t0 });
      logger.info({ eventId }, 'Trust score too low — skipping PR');
      db.prepare(`UPDATE events SET status = 'trust_rejected' WHERE id = ?`).run(eventId);
      trackEvent('pipeline_trust_rejected');
      tracer.endTrace(eventId, 'trust_rejected');
      return;
    }
    const reasoning = [`score=${trusted.trustScore.score}`, `level=${trusted.trustScore.level}`];
    tracer.logDecision({ eventId, step: 'trust_scorer', decision: 'TRUST_APPROVED', confidence: trusted.trustScore.score, reasoning, output: { score: trusted.trustScore.score, level: trusted.trustScore.level }, durationMs: Date.now() - t0 });
    context._trustScore = trusted.trustScore;
  }

  // Step 8: Deterministic verification (typecheck + lint)
  if (process.env.VERIFIER_ENABLED !== 'false') {
    const t0 = Date.now();
    const verifier = new DeterministicVerifier();
    try {
      const cloneUrl = payload.repository?.clone_url || payload.repository?.html_url;
      const branch = context.defaultBranch || 'main';
      const verifyResult = await verifier.verify(cloneUrl, branch, diff, context.fileContents);
      if (!verifyResult.passed && verifyResult.errors.length > 0) {
        const reasoning = [`errors=${verifyResult.errors.join(', ')}`, `checks_run=${verifyResult.checks?.length || 0}`];
        tracer.logDecision({ eventId, step: 'verifier', decision: 'VERIFICATION_FAILED', confidence: 0.1, reasoning, alternatives: [
          { alternative: 'create PR anyway', reasonRejected: 'typecheck/lint errors present', score: 0.1 },
          { alternative: 'regenerate patch', reasonRejected: 'not implemented — single attempt policy', score: 0.3 },
        ], input: { cloneUrl, branch }, output: { errors: verifyResult.errors }, durationMs: Date.now() - t0 });
        logger.warn({ eventId, errors: verifyResult.errors }, 'Verification failed');
        db.prepare(`UPDATE events SET status = 'verification_failed' WHERE id = ?`).run(eventId);
        trackEvent('pipeline_verification_failed', 1, { errors: verifyResult.errors });
        tracer.endTrace(eventId, 'verification_failed');
        return;
      }
      const reasoning = [`${verifyResult.checks?.length || 0} checks passed`];
      tracer.logDecision({ eventId, step: 'verifier', decision: 'VERIFICATION_PASSED', confidence: 0.95, reasoning, output: { checks: verifyResult.checks?.length || 0 }, durationMs: Date.now() - t0 });
      if (verifyResult.passed) {
        trackEvent('pipeline_verification_passed', 1, { checks: verifyResult.checks.length });
      }
    } finally {
      verifier.cleanup();
    }
  } else {
    tracer.logDecision({ eventId, step: 'verifier', decision: 'VERIFIER_DISABLED', confidence: 1.0, reasoning: ['VERIFIER_ENABLED=false, skipping typecheck/lint'], durationMs: 0 });
  }

  // Step 9: Create PR with trust-enhanced body
  try {
    const t0 = Date.now();
    const pr = await createPR(octokit, context, fixType, diff, trusted.prBody);
    const reasoning = [`prNumber=${pr.number}`, `repo=${owner}/${repo}`];
    tracer.logDecision({ eventId, step: 'pr_creation', decision: 'PR_CREATED', confidence: 1.0, reasoning, output: { prNumber: pr.number, prUrl: pr.html_url }, durationMs: Date.now() - t0 });

    db.prepare(`INSERT INTO prs (pr_number, repo_id, event_id, fix_type, branch_name, diff_preview, pr_url, status, opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'opened', datetime('now'))`)
      .run(pr.number, repoId, eventId, fixType, pr.head?.ref, diff.slice(0, 500), pr.html_url);
    db.prepare(`UPDATE events SET status = 'pr_created' WHERE id = ?`).run(eventId);
    incrementUsage(installationId);
    trackEvent('pr_created', 1, { trustScore: trusted.trustScore.score, trustLevel: trusted.trustScore.level });
    trackEvent(`pr_${fixType}`);
    trackEvent(`trust_${trusted.trustScore.level}`);

    const duration = Date.now() - startTime;
    logger.info({ eventId, prNumber: pr.number, trustScore: trusted.trustScore, duration: `${duration}ms` }, 'Pipeline complete');
    trackEvent('pipeline_completed', 1, { duration_ms: duration, trustScore: trusted.trustScore.score });

    const memory = await getLearningSystem();
    if (!memorySource) {
      memory.recordPattern(fixType, diff, { ...context, repo: `${owner}/${repo}` }, true);
    }

    const graph = getGraph();
    const filesChanged = Object.keys(context.fileContents || {});
    ingestor.ingestPR(pr, repoLabel, fixType);
    graph.recordFix(owner, repo, payload.issue?.number || 0, pr.number, fixType, diff.slice(0, 200), filesChanged, true);

    // Metacognition: record behavior + strategy outcome
    {
      const switchDetector = getSwitchDetector();
      switchDetector.recordAttempt('patch_generation', memorySource ? 'memory' : 'llm', `${owner}/${repo}`, true, trusted.trustScore.score, duration);
      const apiLearner = getApiLearner();
      const lang = payload.repository?.language || 'unknown';
      const filesList = Object.keys(context.fileContents || {});
      const filePattern = filesList.length > 0 ? filesList[0].split('/').pop() : '*';
      apiLearner.recordStrategyOutcome(lang, fixType, filePattern, memorySource ? 'template_apply' : 'direct_edit', true);
    }

    tracer.endTrace(eventId, 'completed');
  } catch (err) {
    const reasoning = [`error=${err.message}`];
    tracer.logDecision({ eventId, step: 'pr_creation', decision: 'PR_FAILED', confidence: 0, reasoning, output: { error: err.message }, durationMs: Date.now() - startTime, status: 'failed' });

    logger.error({ err, eventId }, 'PR creation failed');
    db.prepare(`UPDATE events SET status = 'pr_failed' WHERE id = ?`).run(eventId);
    db.prepare(`INSERT INTO prs (repo_id, event_id, fix_type, diff_preview, status, error)
      VALUES (?, ?, ?, ?, 'failed', ?)`)
      .run(repoId, eventId, fixType, diff.slice(0, 500), err.message);
    trackEvent('pipeline_pr_failed');

    const memory = await getLearningSystem();
    memory.recordRejection(`${owner}/${repo}`, fixType, err.message, diff, context);
    const graph = getGraph();
    graph.recordFix(owner, repo, 0, 0, fixType, diff?.slice(0, 200) || '', Object.keys(context?.fileContents || {}), false);

    // Metacognition: record failure
    try {
      const switchDetector = getSwitchDetector();
      switchDetector.recordAttempt('pr_creation', memorySource ? 'memory' : 'llm', `${owner}/${repo}`, false, 0, Date.now() - startTime);
      const trapDetector = getTrapDetector();
      trapDetector.learnFromRejection(eventId, fixType, repoLabel, err.message, context);
    } catch (_) {}

    tracer.endTrace(eventId, 'failed');
  }
}
