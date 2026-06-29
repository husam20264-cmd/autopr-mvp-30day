import { describe, it } from 'node:test';
import assert from 'node:assert';
import { safetyCheck } from '../services/safety/index.js';

describe('safetyCheck', () => {
  const context = { repo: 'test-repo' };

  it('rejects null diff', () => {
    const result = safetyCheck(null, context);
    assert.strictEqual(result.safe, false);
  });

  it('rejects diffs with banned rm -rf pattern', () => {
    const diff = '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-ok\n+rm -rf /';
    const result = safetyCheck(diff, context);
    assert.strictEqual(result.safe, false);
  });

  it('accepts a clean minimal diff', () => {
    const diff = '--- a/src/index.js\n+++ b/src/index.js\n@@ -1,3 +1,3 @@\n const x = 1;\n-const y = 2;\n+const y = 3;\n const z = 4;';
    const result = safetyCheck(diff, context);
    assert.strictEqual(result.safe, true);
  });

  it('rejects production repos', () => {
    const prodContext = { repo: 'my-production-app' };
    const diff = '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b';
    const result = safetyCheck(diff, prodContext);
    assert.strictEqual(result.safe, false);
  });
});
