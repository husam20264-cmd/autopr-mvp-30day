import 'dotenv/config';
import pino from 'pino';
import config from '../config/default.js';
import { getDb } from '../data/db.js';
import { runPipeline } from './pipeline.js';

const logger = pino({ level: config.logLevel });
const db = getDb();

logger.info('AutoPR Worker started');

async function pollEvents() {
  const events = db.prepare(`SELECT id, installation_id, repo_id, event_type, action, payload
    FROM events WHERE status = 'pending' ORDER BY created_at ASC LIMIT 5`).all();

  for (const event of events) {
    try {
      const payload = JSON.parse(event.payload);
      await runPipeline({
        eventId: event.id,
        eventType: event.event_type,
        action: event.action,
        installationId: event.installation_id,
        repoId: event.repo_id,
        payload,
      });
    } catch (err) {
      logger.error({ err, eventId: event.id }, 'Event processing failed');
      db.prepare(`UPDATE events SET status = 'failed' WHERE id = ?`).run(event.id);
    }
  }
}

setInterval(pollEvents, 10000);
