import 'dotenv/config';
import express from 'express';
import pino from 'pino';
import config from '../../config/default.js';
import { getDb } from '../../data/db.js';
import { getGithubApp } from '../../services/github/app.js';
import { handleGitHubWebhook } from './github.js';
import { handleStripeWebhook } from './stripe.js';
import { handleGTMRequest } from './gtm.js';
import { handleExplainRequest, handleWhyRequest, handleTraceRequest } from './decision.js';
import { getTruthMetrics, getCalibrator, getTruthTracker } from '../../services/truth/index.js';
import { getSwitchDetector, getRuleMutator, getPolicyPromoter, getApiLearner, getTrapDetector, runMetaCognitionCycle } from '../../services/metacognition/index.js';

const logger = pino({ level: config.logLevel });
const app = express();
const db = getDb();

// Define built-in trap patterns at startup
{
  const td = getTrapDetector();
  td.defineTrap('production_repo', 'env_check', 'repoHas=prod', 'skipping production repos', 'high');
  td.defineTrap('large_diff', 'size_check', 'diffSize>2500', 'diff exceeds safety limit', 'high');
  td.defineTrap('rapid_fail_ci', 'consecutive_failure', 'consecutiveFailures>3', 'CI fails consistently for this repo+fixType', 'medium');
}

// Define built-in rules
{
  const rm = getRuleMutator();
  rm.defineRule('max_diff_rule', 'threshold', 'diffSize>3000', 'reject', 100);
  rm.defineRule('min_trust_rule', 'threshold', 'trustScore<0.3', 'reject', 90);
  rm.defineRule('production_safety', 'pattern', 'repoHas=prod', 'manual_review', 80);
}

app.post('/webhooks/github', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const result = await handleGitHubWebhook(req);
    res.status(200).json(result);
  } catch (err) {
    logger.error({ err, event: req.headers['x-github-event'] }, 'GitHub webhook failed');
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const result = await handleStripeWebhook(req);
    res.status(200).json(result);
  } catch (err) {
    logger.error({ err }, 'Stripe webhook failed');
    res.status(400).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/api/gtm', (req, res) => handleGTMRequest(req, res));
app.get('/api/explain', (req, res) => handleExplainRequest(req, res));
app.get('/api/why', (req, res) => handleWhyRequest(req, res));
app.get('/api/trace', (req, res) => handleTraceRequest(req, res));
app.get('/api/truth/accuracy', (req, res) => {
  const metrics = getTruthMetrics();
  res.json(metrics.getAccuracy(parseInt(req.query.days) || 30));
});
app.get('/api/truth/precision-recall', (req, res) => {
  const metrics = getTruthMetrics();
  res.json(metrics.getPrecisionRecall(parseInt(req.query.days) || 30));
});
app.get('/api/truth/summary', (req, res) => {
  const metrics = getTruthMetrics();
  res.json(metrics.getSummary());
});
app.get('/api/truth/trend', (req, res) => {
  const metrics = getTruthMetrics();
  res.json(metrics.getTrend(parseInt(req.query.days) || 90));
});
app.get('/api/truth/calibrate', async (req, res) => {
  const calibrator = getCalibrator();
  const results = calibrator.calibrateAll();
  res.json(results);
});
app.get('/api/truth/thresholds', (req, res) => {
  const calibrator = getCalibrator();
  res.json(calibrator.getAllThresholds());
});
app.get('/api/truth/outcomes', (req, res) => {
  const tracker = getTruthTracker();
  const fixType = req.query.fixType || null;
  res.json(tracker.getAllTruth(fixType, parseInt(req.query.limit) || 100));
});

app.get('/api/meta/behaviors', (req, res) => {
  const sd = getSwitchDetector();
  const component = req.query.component;
  res.json(component ? sd.getComponentHealth(component) : sd.getAllComponents());
});
app.get('/api/meta/rules', (req, res) => {
  const rm = getRuleMutator();
  res.json(rm.getActiveRules());
});
app.get('/api/meta/mutate', (req, res) => {
  const rm = getRuleMutator();
  res.json(rm.mutateAll());
});
app.get('/api/meta/policies', (req, res) => {
  const pp = getPolicyPromoter();
  res.json(pp.getActivePolicies());
});
app.get('/api/meta/promote', (req, res) => {
  const pp = getPolicyPromoter();
  res.json({ promoted: pp.evaluatePatternsForPromotion() });
});
app.get('/api/meta/strategies', (req, res) => {
  const al = getApiLearner();
  res.json(al.getAllLearnedStrategies());
});
app.get('/api/meta/traps', (req, res) => {
  const td = getTrapDetector();
  res.json(req.query.severity ? td.getTrapsBySeverity(req.query.severity) : td.getAllTraps());
});
app.get('/api/meta/trap-summary', (req, res) => {
  const td = getTrapDetector();
  res.json(td.getTrapSummary());
});
app.get('/api/meta/cycle', async (req, res) => {
  const results = await runMetaCognitionCycle();
  res.json(results);
});

let server;

if (process.env.NODE_ENV !== 'test') {
  server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'AutoPR MVP listening');
  });
}

export { app, server, db, logger };
