import crypto from 'crypto';
import { getDb } from '../../data/db.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export class EmbeddingStore {
  constructor(dimension = 128) {
    this.db = getDb();
    this.dimension = dimension;
  }

  hashFeatures(text) {
    const features = {};
    const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 2);

    for (const word of words) {
      const hash = parseInt(crypto.createHash('md5').update(word).digest('hex').slice(0, 8), 16);
      const idx = hash % this.dimension;
      features[idx] = (features[idx] || 0) + 1;
    }

    const vector = new Float32Array(this.dimension);
    for (const [idx, count] of Object.entries(features)) {
      vector[parseInt(idx)] = count;
    }

    const magnitude = Math.sqrt(Array.from(vector).reduce((s, v) => s + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < this.dimension; i++) {
        vector[i] /= magnitude;
      }
    }

    return vector;
  }

  storeEmbedding(nodeId, text) {
    const vector = this.hashFeatures(text);
    const buffer = Buffer.from(vector.buffer);
    this.db.prepare(`DELETE FROM embeddings WHERE node_id = ?`).run(nodeId);
    this.db.prepare(`INSERT OR IGNORE INTO embeddings (node_id, vector, dimension) VALUES (?, ?, ?)`).run(nodeId, buffer, this.dimension);
    return nodeId;
  }

  cosineSimilarity(a, b) {
    const vecA = new Float32Array(a.buffer, a.byteOffset, a.length / 4);
    const vecB = new Float32Array(b.buffer, b.byteOffset, b.length / 4);

    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
      magA += vecA[i] * vecA[i];
      magB += vecB[i] * vecB[i];
    }

    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
  }

  search(query, { nodeType, limit = 10, minSimilarity = 0.3 } = {}) {
    const queryVec = this.hashFeatures(query);
    const queryBuf = Buffer.from(queryVec.buffer);

    let rows;
    if (nodeType) {
      rows = this.db.prepare(`
        SELECT e.*, n.node_type, n.label, n.properties
        FROM embeddings e
        JOIN knowledge_nodes n ON n.id = e.node_id
        WHERE n.node_type = ?
      `).all(nodeType);
    } else {
      rows = this.db.prepare(`
        SELECT e.*, n.node_type, n.label, n.properties
        FROM embeddings e
        JOIN knowledge_nodes n ON n.id = e.node_id
      `).all();
    }

    const results = rows.map(row => ({
      nodeId: row.node_id,
      nodeType: row.node_type,
      label: row.label,
      properties: JSON.parse(row.properties || '{}'),
      similarity: this.cosineSimilarity(queryBuf, row.vector),
    }));

    return results
      .filter(r => r.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  findSimilar(nodeId, { limit = 10, minSimilarity = 0.3 } = {}) {
    const source = this.db.prepare(`SELECT * FROM embeddings WHERE node_id = ?`).get(nodeId);
    if (!source) return [];

    const rows = this.db.prepare(`
      SELECT e.*, n.node_type, n.label, n.properties
      FROM embeddings e
      JOIN knowledge_nodes n ON n.id = e.node_id
      WHERE e.node_id != ?
    `).all(nodeId);

    const results = rows.map(row => ({
      nodeId: row.node_id,
      nodeType: row.node_type,
      label: row.label,
      similarity: this.cosineSimilarity(source.vector, row.vector),
    }));

    return results
      .filter(r => r.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }
}
