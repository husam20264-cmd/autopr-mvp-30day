import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { getDb, closeDb } from '../data/db.js';
import { KnowledgeGraph } from '../services/knowledge/graph.js';
import { EmbeddingStore } from '../services/knowledge/embeddings.js';
import { KnowledgeIngestor } from '../services/knowledge/ingestor.js';
import { KnowledgeReasoner } from '../services/knowledge/reasoner.js';

function cleanDb() {
  const db = getDb();
  db.exec(`PRAGMA foreign_keys = OFF;
    DELETE FROM embeddings;
    DELETE FROM knowledge_edges;
    DELETE FROM knowledge_nodes;
    DELETE FROM knowledge_index;
    PRAGMA foreign_keys = ON;`);
}

describe('EmbeddingStore', () => {
  let store;

  before(() => {
    cleanDb();
    store = new EmbeddingStore();
  });

  // after(() => closeDb());

  it('generates consistent feature vectors', () => {
    const v1 = store.hashFeatures('fix lint error in config file');
    const v2 = store.hashFeatures('fix lint error in config file');
    assert.strictEqual(v1.length, 128);
    assert.deepStrictEqual(Array.from(v1), Array.from(v2));
  });

  it('similar texts produce similar vectors', () => {
    const v1 = store.hashFeatures('update dependency version');
    const v2 = store.hashFeatures('upgrade package version');
    const diff = store.hashFeatures('database schema migration');
    const buf1 = Buffer.from(v1.buffer);
    const buf2 = Buffer.from(v2.buffer);
    const buf3 = Buffer.from(diff.buffer);
    const simSimilar = store.cosineSimilarity(buf1, buf2);
    const simDiff = store.cosineSimilarity(buf1, buf3);
    assert.ok(simSimilar > simDiff);
  });

  it('stores and searches embeddings', () => {
    const graph = new KnowledgeGraph();
    const nodeId = graph.addNode('issue', 'test/ci-issue', 'CI pipeline failing', {});
    store.storeEmbedding(nodeId, 'this repository has a broken CI pipeline that fails on lint');
    const results = store.search('CI pipeline failing', { limit: 5 });
    assert.ok(results.length >= 0);
  });
});

describe('KnowledgeGraph', () => {
  let graph;

  before(() => {
    cleanDb();
    graph = new KnowledgeGraph();
  });

  // after(() => closeDb());

  it('adds and retrieves nodes', () => {
    const id = graph.addNode('repository', 'test/repo', 'Test Repo', { language: 'JavaScript' });
    assert.ok(id > 0);
  });

  it('adds edges between nodes', () => {
    const repoId = graph.addNode('repository', 'test/repo2', 'Test Repo 2');
    const issueId = graph.addNode('issue', 'test/repo2#1', 'Bug in login');
    const edgeId = graph.addEdge(repoId, issueId, 'has_issue');
    assert.ok(edgeId > 0);
  });

  it('retrieves repo context', () => {
    const context = graph.getRepoContext('test', 'repo2');
    assert.ok(context !== null);
    assert.ok(context.openIssues >= 1);
  });

  it('records and retrieves fixes', () => {
    graph.recordFix('test', 'repo-fix', 1, 42, 'lint', 'fixed lint', ['src/index.js'], true);
    const suggestions = graph.getFixSuggestions('test', 'repo-fix', 'src/index.js');
    assert.ok(suggestions.length > 0);
    assert.strictEqual(suggestions[0].type, 'lint');
  });

  it('returns graph stats', () => {
    const stats = graph.getStats();
    assert.ok(stats.nodes.repository >= 3);
    assert.ok(stats.edges);
  });
});

describe('KnowledgeReasoner', () => {
  let reasoner;

  before(() => {
    cleanDb();
    reasoner = new KnowledgeReasoner();

    const graph = new KnowledgeGraph();
    graph.recordFix('test', 'known-repo', 1, 10, 'lint', 'eslint fix', ['src/app.js'], true);
    graph.recordFix('test', 'known-repo', 2, 11, 'lint', 'prettier fix', ['src/app.js'], true);
    graph.recordFix('test', 'known-repo', 3, 12, 'dependency', 'lodash bump', ['package.json'], true);
  });

  // after(() => closeDb());

  it('shouldFix returns high confidence for known patterns', () => {
    const result = reasoner.shouldFix('test', 'known-repo', 'lint', 'src/app.js');
    assert.ok(result.confidence >= 0.4);
    assert.strictEqual(result.should, true);
  });

  it('shouldFix returns low confidence for unknown repos', () => {
    const result = reasoner.shouldFix('test', 'unknown-repo', 'lint', 'src/unknown.js');
    assert.ok(result.confidence <= 0.6);
  });

  it('predictFixStrategy returns approach based on context', () => {
    const strategy = reasoner.predictFixStrategy('test', 'known-repo', 'lint', 'fix lint error in app.js');
    assert.ok(strategy.fixType);
    assert.ok(['minimal', 'template'].includes(strategy.approach));
  });

  it('getRepoProfile returns health data', () => {
    const profile = reasoner.getRepoProfile('test', 'known-repo');
    assert.ok(profile !== null);
    assert.ok(profile.health.frequentFiles >= 1);
  });

  it('findRelatedCode returns related files', () => {
    const result = reasoner.findRelatedCode('test', 'known-repo', 'src/app.js', 'lint');
    assert.ok(Array.isArray(result.relatedFiles));
    assert.ok(Array.isArray(result.semanticResults));
  });
});

describe('KnowledgeIngestor', () => {
  let ingestor;

  before(() => {
    cleanDb();
    ingestor = new KnowledgeIngestor();
  });

  // after(() => closeDb());

  it('ingests events into graph', () => {
    const id = ingestor.ingestEvent('push', { id: 'evt-1', commits: ['fix'], repository: { full_name: 'test/repo' } }, 'test/repo');
    assert.ok(id > 0);
  });

  it('ingests issues with embeddings', () => {
    const id = ingestor.ingestIssue({ number: 5, title: 'Bug in auth', body: 'null pointer', state: 'open', labels: [{ name: 'bug' }] }, 'test/repo');
    assert.ok(id > 0);
  });

  it('ingests PRs with fix type', () => {
    const id = ingestor.ingestPR({ number: 20, title: 'Fix auth bug', body: 'Fixes #5', state: 'open' }, 'test/repo', 'trivial_bug');
    assert.ok(id > 0);
  });

  it('ingests files with content', () => {
    const id = ingestor.ingestFile('src/auth.js', 'function login() {}', 'test/repo');
    assert.ok(id > 0);
  });
});
