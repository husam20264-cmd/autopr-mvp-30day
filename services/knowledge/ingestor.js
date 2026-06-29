import { KnowledgeGraph } from './graph.js';
import { EmbeddingStore } from './embeddings.js';
import { getDb } from '../../data/db.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export class KnowledgeIngestor {
  constructor() {
    this.graph = new KnowledgeGraph();
    this.embeddings = new EmbeddingStore();
    this.db = getDb();
  }

  ingestEvent(eventType, payload, repoLabel) {
    const text = JSON.stringify(payload).slice(0, 5000);

    const eventNodeId = this.graph.addNode('event', `${repoLabel}:${payload.id || Date.now()}`, `${eventType} event`, {
      type: eventType,
      repo: repoLabel,
      summary: text.slice(0, 200),
    });

    this.embeddings.storeEmbedding(eventNodeId, text);

    const repoNode = this.db.prepare(
      `SELECT id FROM knowledge_nodes WHERE node_type = 'repository' AND external_id = ?`
    ).get(repoLabel);
    if (repoNode) {
      this.graph.addEdge(repoNode.id, eventNodeId, 'received_event');
    }

    return eventNodeId;
  }

  ingestIssue(issue, repoLabel) {
    const title = issue.title || '';
    const body = (issue.body || '').slice(0, 3000);
    const text = `${title}\n${body}`;

    const nodeId = this.graph.addNode('issue', `${repoLabel}#${issue.number}`, title, {
      number: issue.number,
      state: issue.state,
      labels: (issue.labels || []).map(l => l.name).join(','),
      repo: repoLabel,
      body: body.slice(0, 500),
    });

    this.embeddings.storeEmbedding(nodeId, text);

    this.db.prepare(`INSERT OR REPLACE INTO knowledge_index (node_type, field, value, node_id) VALUES (?, ?, ?, ?)`)
      .run('issue', 'repo', repoLabel, nodeId);
    for (const label of issue.labels || []) {
      this.db.prepare(`INSERT OR IGNORE INTO knowledge_index (node_type, field, value, node_id) VALUES (?, ?, ?, ?)`)
        .run('issue', 'label', label.name, nodeId);
    }

    return nodeId;
  }

  ingestPR(pr, repoLabel, fixType) {
    const title = pr.title || '';
    const body = (pr.body || '').slice(0, 3000);
    const text = `${title}\n${body}`;

    const nodeId = this.graph.addNode('pr', `${repoLabel}#${pr.number}`, title, {
      number: pr.number,
      state: pr.state,
      fixType,
      repo: repoLabel,
    });

    this.embeddings.storeEmbedding(nodeId, text);

    this.db.prepare(`INSERT OR REPLACE INTO knowledge_index (node_type, field, value, node_id) VALUES (?, ?, ?, ?)`)
      .run('pr', 'repo', repoLabel, nodeId);
    this.db.prepare(`INSERT OR IGNORE INTO knowledge_index (node_type, field, value, node_id) VALUES (?, ?, ?, ?)`)
      .run('pr', 'fixType', fixType, nodeId);

    // Link to related issues via body references
    const issueRefs = body.match(/#\d+/g) || [];
    for (const ref of issueRefs) {
      const issueNode = this.db.prepare(
        `SELECT id FROM knowledge_nodes WHERE node_type = 'issue' AND external_id = ?`
      ).get(`${repoLabel}${ref}`);
      if (issueNode) {
        this.graph.addEdge(issueNode.id, nodeId, 'triggered_pr');
      }
    }

    return nodeId;
  }

  ingestFile(path, content, repoLabel) {
    const nodeId = this.graph.addNode('file', `${repoLabel}:${path}`, path, { path, repo: repoLabel });
    this.embeddings.storeEmbedding(nodeId, (content || '').slice(0, 5000));

    this.db.prepare(`INSERT OR REPLACE INTO knowledge_index (node_type, field, value, node_id) VALUES (?, ?, ?, ?)`)
      .run('file', 'repo', repoLabel, nodeId);
    this.db.prepare(`INSERT OR IGNORE INTO knowledge_index (node_type, field, value, node_id) VALUES (?, ?, ?, ?)`)
      .run('file', 'path', path, nodeId);

    return nodeId;
  }

  ingestRepo(repo, files = {}) {
    const repoLabel = repo.full_name || `${repo.owner}/${repo.name}`;
    const nodeId = this.graph.addNode('repository', repoLabel, repoLabel, {
      owner: repo.owner,
      name: repo.name,
      language: repo.language,
      stars: repo.stargazers_count,
    });

    this.embeddings.storeEmbedding(nodeId, `${repoLabel} ${repo.description || ''} ${repo.language || ''}`);

    for (const [path, content] of Object.entries(files)) {
      const fileNodeId = this.ingestFile(path, content, repoLabel);
      this.graph.addEdge(nodeId, fileNodeId, 'contains');
    }

    return nodeId;
  }
}
