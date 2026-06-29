import { getDb } from '../../data/db.js';
import { getLearningSystem } from '../learning/index.js';
import { getGraph, getIngestor } from '../knowledge/index.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export class TruthReconciler {
  constructor() {
    this.db = getDb();
  }

  async reconcile({ prNumber, repo, fixType, outcome, eventId, diffPreview, contextSnapshot }) {
    const isAccepted = outcome === 'merged';

    // 1. PatternMemory: adjust pattern confidence
    if (fixType && diffPreview) {
      await this.updatePatternMemory(fixType, diffPreview, repo, isAccepted, contextSnapshot);
    }

    // 2. KnowledgeGraph: update fix acceptance status
    if (fixType) {
      this.updateKnowledgeGraph(repo, prNumber, fixType, isAccepted);
    }

    // 3. Trust calibration: adjust per-repo acceptance rate
    if (repo && fixType) {
      this.updateCalibration(repo, fixType, isAccepted);
    }

    // 4. Accuracy metrics: record daily accuracy
    this.recordAccuracyMetric(fixType, isAccepted);

    logger.info({ prNumber, repo, outcome, fixType, layersUpdated: 4 }, 'Truth reconciled across all layers');
    return { reconciled: true, layers: ['pattern_memory', 'knowledge_graph', 'calibration', 'accuracy'] };
  }

  async updatePatternMemory(fixType, diffPreview, repo, accepted, contextSnapshot) {
    try {
      const memory = await getLearningSystem();
      if (accepted) {
        memory.recordPattern(fixType, diffPreview, { ...(contextSnapshot || {}), repo }, true);
      } else {
        memory.recordRejection(repo, fixType, 'PR closed without merge', diffPreview, contextSnapshot);
      }
    } catch (err) {
      logger.error({ err }, 'Failed to update pattern memory from truth');
    }
  }

  updateKnowledgeGraph(repo, prNumber, fixType, accepted) {
    try {
      const graph = getGraph();
      graph.recordFix(
        repo.split('/')[0], repo.split('/')[1] || repo,
        0, prNumber, fixType, `truth:${fixType}`, [], accepted,
      );
    } catch (err) {
      logger.error({ err }, 'Failed to update knowledge graph from truth');
    }
  }

  updateCalibration(repo, fixType, accepted) {
    const existing = this.db.prepare(
      `SELECT current_value, sample_size, history FROM truth_calibration WHERE metric = ?`
    ).get(`${repo}:${fixType}`);

    if (existing) {
      const history = JSON.parse(existing.history || '[]');
      history.push({ accepted, date: new Date().toISOString() });

      const newSampleSize = existing.sample_size + 1;
      const newValue = (existing.current_value * existing.sample_size + (accepted ? 1 : 0)) / newSampleSize;

      this.db.prepare(`
        UPDATE truth_calibration SET current_value = ?, sample_size = ?, history = ?, last_calibrated = datetime('now')
        WHERE metric = ?
      `).run(newValue, newSampleSize, JSON.stringify(history), `${repo}:${fixType}`);
    } else {
      this.db.prepare(`
        INSERT INTO truth_calibration (metric, current_value, sample_size, history)
        VALUES (?, ?, 1, ?)
      `).run(`${repo}:${fixType}`, accepted ? 1 : 0, JSON.stringify([{ accepted, date: new Date().toISOString() }]));
    }
  }

  recordAccuracyMetric(fixType, correct) {
    const today = new Date().toISOString().slice(0, 10);
    const existing = this.db.prepare(
      `SELECT id, total, correct FROM accuracy_metrics WHERE date = ? AND fix_type = ?`
    ).get(today, fixType || 'all');

    if (existing) {
      this.db.prepare(`
        UPDATE accuracy_metrics SET total = total + 1, correct = correct + ?, incorrect = incorrect + ?,
          false_positive = false_positive + ?, false_negative = false_negative + ?
        WHERE id = ?
      `).run(correct ? 1 : 0, correct ? 0 : 1, correct ? 0 : 0, correct ? 0 : 0, existing.id);
    } else {
      this.db.prepare(`
        INSERT INTO accuracy_metrics (date, fix_type, total, correct, incorrect)
        VALUES (?, ?, 1, ?, ?)
      `).run(today, fixType || 'all', correct ? 1 : 0, correct ? 0 : 1);
    }
  }
}
