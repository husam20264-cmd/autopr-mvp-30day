import { getDb } from '../../data/db.js';

export function trackEvent(metric, value = 1, metadata = {}) {
  const db = getDb();
  const date = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO analytics (date, metric, value, metadata) VALUES (?, ?, ?, ?)`)
    .run(date, metric, value, JSON.stringify(metadata));
}

export function getDailyMetric(metric, days = 30) {
  const db = getDb();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return db.prepare(`SELECT date, SUM(value) as total FROM analytics
    WHERE metric = ? AND date >= ? GROUP BY date ORDER BY date`).all(metric, cutoff);
}

export function getAggregateMetric(metric, days = 30) {
  const db = getDb();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const row = db.prepare(`SELECT SUM(value) as total FROM analytics
    WHERE metric = ? AND date >= ?`).get(metric, cutoff);
  return row?.total || 0;
}
