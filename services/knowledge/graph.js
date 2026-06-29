import { getDb } from '../../data/db.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export class KnowledgeGraph {
  constructor() {
    this.db = getDb();
  }

  addNode(nodeType, externalId, label, properties = {}) {
    const existing = this.db.prepare(
      `SELECT id FROM knowledge_nodes WHERE node_type = ? AND external_id = ?`
    ).get(nodeType, externalId);

    if (existing) {
      this.db.prepare(`
        UPDATE knowledge_nodes SET label = ?, properties = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(label, JSON.stringify(properties), existing.id);
      return existing.id;
    }

    const { lastInsertRowid } = this.db.prepare(`
      INSERT INTO knowledge_nodes (node_type, external_id, label, properties)
      VALUES (?, ?, ?, ?)
    `).run(nodeType, externalId, label, JSON.stringify(properties));

    logger.info({ nodeType, externalId, label }, 'Graph node added');
    return lastInsertRowid;
  }

  addEdge(sourceNodeId, targetNodeId, relationType, weight = 1.0, properties = {}) {
    const existing = this.db.prepare(`
      SELECT id FROM knowledge_edges
      WHERE source_node_id = ? AND target_node_id = ? AND relation_type = ?
    `).get(sourceNodeId, targetNodeId, relationType);

    if (existing) {
      this.db.prepare(`
        UPDATE knowledge_edges SET weight = weight + ?, properties = ?, created_at = datetime('now')
        WHERE id = ?
      `).run(weight, JSON.stringify(properties), existing.id);
      return existing.id;
    }

    const { lastInsertRowid } = this.db.prepare(`
      INSERT INTO knowledge_edges (source_node_id, target_node_id, relation_type, weight, properties)
      VALUES (?, ?, ?, ?, ?)
    `).run(sourceNodeId, targetNodeId, relationType, weight, JSON.stringify(properties));

    return lastInsertRowid;
  }

  recordFix(repoOwner, repoName, issueNumber, prNumber, fixType, diffSummary, filesChanged, accepted) {
    const repoLabel = `${repoOwner}/${repoName}`;

    const repoNodeId = this.addNode('repository', repoLabel, repoLabel, { owner: repoOwner, name: repoName });
    const issueNodeId = this.addNode('issue', `${repoLabel}#${issueNumber}`, `Issue #${issueNumber}`, { repo: repoLabel, number: issueNumber });
    const prNodeId = this.addNode('pr', `${repoLabel}#${prNumber}`, `PR #${prNumber}`, { repo: repoLabel, number: prNumber, fixType, accepted });

    this.addEdge(repoNodeId, issueNodeId, 'has_issue');
    this.addEdge(issueNodeId, prNodeId, 'resolved_by');
    this.addEdge(prNodeId, repoNodeId, 'fixes_in');

    for (const file of filesChanged || []) {
      const fileNodeId = this.addNode('file', `${repoLabel}:${file}`, file, { repo: repoLabel, path: file });
      this.addEdge(prNodeId, fileNodeId, 'modifies');
      if (accepted) {
        const existing = this.db.prepare(`
          SELECT e.weight FROM knowledge_edges e
          JOIN knowledge_nodes n ON n.id = e.target_node_id
          WHERE e.source_node_id = ? AND e.relation_type = 'fixes_file'
        `).get(repoNodeId);
        if (existing) {
          this.db.prepare(`UPDATE knowledge_edges SET weight = ? WHERE source_node_id = ? AND target_node_id = ? AND relation_type = 'fixes_file'`)
            .run(existing.weight + 0.1, repoNodeId, fileNodeId);
        } else {
          this.addEdge(repoNodeId, fileNodeId, 'fixes_file', 0.5);
        }
      }
    }

    logger.info({ repoLabel, issueNumber, prNumber, fixType, accepted }, 'Fix recorded in knowledge graph');
    return { repoNodeId, issueNodeId, prNodeId };
  }

  getRepoContext(repoOwner, repoName) {
    const repoLabel = `${repoOwner}/${repoName}`;
    const repo = this.db.prepare(`SELECT id, properties FROM knowledge_nodes WHERE node_type = 'repository' AND external_id = ?`).get(repoLabel);
    if (!repo) return null;

    const issues = this.db.prepare(`
      SELECT n.*, e.created_at as edge_created
      FROM knowledge_edges e
      JOIN knowledge_nodes n ON n.id = e.target_node_id
      WHERE e.source_node_id = ? AND e.relation_type = 'has_issue'
      ORDER BY e.created_at DESC LIMIT 10
    `).all(repo.id);

    const recentPRs = this.db.prepare(`
      SELECT n.*, e.weight
      FROM knowledge_edges e
      JOIN knowledge_nodes n ON n.id = e.target_node_id
      WHERE e.source_node_id = ? AND e.relation_type = 'resolved_by'
      ORDER BY e.created_at DESC LIMIT 5
    `).all(repo.id);

    const frequentFiles = this.db.prepare(`
      SELECT n.*, e.weight
      FROM knowledge_edges e
      JOIN knowledge_nodes n ON n.id = e.target_node_id
      WHERE e.source_node_id = ? AND e.relation_type = 'fixes_file'
      ORDER BY e.weight DESC LIMIT 5
    `).all(repo.id);

    return {
      repo: JSON.parse(repo.properties || '{}'),
      openIssues: issues.length,
      recentIssues: issues.map(i => ({ label: i.label, properties: JSON.parse(i.properties || '{}') })),
      recentPRs: recentPRs.map(p => ({ label: p.label, weight: p.weight, properties: JSON.parse(p.properties || '{}') })),
      frequentFiles: frequentFiles.map(f => ({ path: f.label, fixWeight: f.weight })),
    };
  }

  getFilesRelatedTo(repoOwner, repoName, filePath) {
    const repoLabel = `${repoOwner}/${repoName}`;
    const fileNode = this.db.prepare(`
      SELECT id FROM knowledge_nodes WHERE node_type = 'file' AND external_id = ?
    `).get(`${repoLabel}:${filePath}`);

    if (!fileNode) return [];

    const related = this.db.prepare(`
      SELECT DISTINCT n2.label as related_file, e2.relation_type, e2.weight
      FROM knowledge_edges e1
      JOIN knowledge_edges e2 ON e1.source_node_id = e2.source_node_id
      JOIN knowledge_nodes n2 ON n2.id = e2.target_node_id
      WHERE e1.target_node_id = ? AND e1.relation_type = 'modifies'
        AND e2.relation_type = 'modifies' AND n2.id != ?
      ORDER BY e2.weight DESC
      LIMIT 5
    `).all(fileNode.id, fileNode.id);

    return related;
  }

  getFixSuggestions(repoOwner, repoName, filePath) {
    const repoLabel = `${repoOwner}/${repoName}`;

    const similarFixes = this.db.prepare(`
      SELECT n.label, n.properties, e.weight, pr.properties AS pr_properties
      FROM knowledge_edges e
      JOIN knowledge_nodes n ON n.id = e.target_node_id
      JOIN knowledge_nodes repo ON repo.id = e.source_node_id
      LEFT JOIN knowledge_edges me ON me.target_node_id = n.id AND me.relation_type = 'modifies'
      LEFT JOIN knowledge_nodes pr ON pr.id = me.source_node_id AND pr.node_type = 'pr'
      WHERE repo.external_id = ? AND e.relation_type = 'fixes_file'
      ORDER BY e.weight DESC LIMIT 5
    `).all(repoLabel);

    return similarFixes.map(f => ({
      file: f.label,
      confidence: f.weight,
      type: JSON.parse(f.pr_properties || '{}').fixType,
    }));
  }

  getStats() {
    const nodes = this.db.prepare(`SELECT node_type, COUNT(*) as count FROM knowledge_nodes GROUP BY node_type`).all();
    const edges = this.db.prepare(`SELECT relation_type, COUNT(*) as count FROM knowledge_edges GROUP BY relation_type`).all();
    return { nodes: Object.fromEntries(nodes.map(n => [n.node_type, n.count])), edges: Object.fromEntries(edges.map(e => [e.relation_type, e.count])) };
  }
}
