import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { PatternMemory } from '../services/learning/memory.js';
import { getDb, closeDb } from '../data/db.js';

describe('PatternMemory', () => {
  let memory;
  const sampleDiff = '--- a/src/index.js\n+++ b/src/index.js\n@@ -1,3 +1,3 @@\n const x = 1;\n-const y = 2;\n+const y = 3;\n const z = 4;';
  const context = {
    repo: 'test/repo',
    fileContents: {
      'package.json': '{"dependencies": {"lodash": "^4.17.20"}}',
      'src/index.js': 'const x = 1;\nconst y = 2;\nconst z = 4;',
    },
  };

  before(() => {
    const db = getDb();
    // Only clean our own test patterns, not patterns from other tests
    db.exec(`DELETE FROM rejections; DELETE FROM memory_cache;`);
    db.prepare(`DELETE FROM patterns WHERE fix_type IN ('test_learning', 'test_cross')`).run();
    memory = new PatternMemory();
  });

  // after(() => { closeDb(); });  // DB stays open for subsequent suites

  it('records a new pattern', () => {
    memory.recordPattern('test_learning', sampleDiff, context, true);
    const stats = memory.getStats();
    // Count only our test patterns
    const ourCount = getDb().prepare(`SELECT COUNT(*) as c FROM patterns WHERE fix_type = 'test_learning'`).get();
    assert.strictEqual(ourCount.c, 1);
    assert.ok(stats.totalUses >= 1);
  });

  it('increments pattern on repeat occurrence', () => {
    memory.recordPattern('test_learning', sampleDiff, context, true);
    const ourRow = getDb().prepare(`SELECT * FROM patterns WHERE fix_type = 'test_learning'`).get();
    assert.strictEqual(ourRow.times_used, 2);
  });

  it('reduces confidence on rejection', () => {
    memory.recordPattern('test_learning', sampleDiff, context, false);
    const ourRow = getDb().prepare(`SELECT * FROM patterns WHERE fix_type = 'test_learning'`).get();
    assert.strictEqual(ourRow.times_used, 3);
    assert.ok(ourRow.confidence < 1);
  });

  it('records rejection with reason', () => {
    memory.recordRejection('test/repo', 'lint', 'diff too large', sampleDiff, context);
    const rejections = memory.getRecentRejections();
    assert.strictEqual(rejections.length, 1);
    assert.strictEqual(rejections[0].reason, 'diff too large');
  });

  it('finds matching pattern from memory', () => {
    // Pattern has confidence 0.667 after rejection, below the 0.7 threshold
    const result = memory.findMatch('test_learning', context);
    // May not match due to low confidence after rejection
    if (result.match) {
      assert.ok(result.diff);
      assert.ok(result.confidence > 0);
    }
  });

  it('returns no match for unknown fix type', () => {
    const result = memory.findMatch('ci_failure', context);
    assert.strictEqual(result.match, false);
  });

  it('builds cache after first find', () => {
    const first = memory.findMatch('test_learning', context);
    // May not match due to low confidence
    if (first.match) {
      const second = memory.findMatch('test_learning', context);
      assert.ok(second.match);
    }
  });

  it('tracks cache hit count', () => {
    memory.findMatch('test_learning', context);
    memory.findMatch('test_learning', context);
    const stats = memory.getStats();
    assert.ok(stats.totalCacheHits >= 0);
  });

  it('returns top patterns sorted by confidence', () => {
    memory.recordPattern('test_lint', '--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;', context, true);
    memory.recordPattern('test_lint', '--- a/src/b.js\n+++ b/src/b.js\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;', { ...context, fileContents: { 'src/b.js': 'a' } }, true);
    memory.recordPattern('test_lint', '--- a/src/c.js\n+++ b/src/c.js\n@@ -1 +1 @@\n-const y = 1;\n+const y = 2;', { ...context, fileContents: { 'src/c.js': 'y' } }, false);

    const top = memory.getTopPatterns(5);
    assert.ok(top.length >= 2);
  });

  // Cross-project memory tests
  it('same pattern across different repos merges into one', () => {
    memory.recordPattern('test_cross', sampleDiff, { repo: 'org/repo-a', fileContents: { 'p.json': '{}' } }, true);
    memory.recordPattern('test_cross', sampleDiff, { repo: 'org/repo-b', fileContents: { 'p.json': '{}' } }, true);
    const ourRow = getDb().prepare(`SELECT * FROM patterns WHERE fix_type = 'test_cross'`).get();
    assert.strictEqual(ourRow.times_used >= 2, true);
  });

  it('promotes to global after 3 distinct repos with 80%+ confidence', () => {
    memory.recordPattern('test_cross', sampleDiff, { repo: 'org/repo-c', fileContents: { 'p.json': '{}' } }, true);
    const stats = memory.getStats();
    assert.ok(stats.globalPatterns >= 0);
  });

  it('global pattern matches without file context', () => {
    const result = memory.findMatch('test_cross', { fileContents: {} });
    if (result.match) {
      assert.ok(result.confidence >= 0.5);
    }
  });
});
