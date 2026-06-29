import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DeterministicVerifier } from '../services/verifier/index.js';

describe('DeterministicVerifier', () => {
  it('parses a unified diff into files', () => {
    const diff = [
      '--- a/src/index.js',
      '+++ b/src/index.js',
      '@@ -1,3 +1,3 @@',
      ' const x = 1;',
      '-const y = 2;',
      '+const y = 3;',
      ' const z = 4;',
    ].join('\n');

    const verifier = new DeterministicVerifier();
    const files = verifier.parseDiffFiles(diff);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].path, 'src/index.js');
    assert.ok(files[0].content.includes('const y = 3;'));
    assert.ok(!files[0].content.includes('const y = 2;'));
    assert.ok(files[0].content.includes('const x = 1;'));
    assert.ok(files[0].content.includes('const z = 4;'));
  });

  it('parses multi-file diffs', () => {
    const diff = [
      '--- a/src/a.js',
      '+++ b/src/a.js',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '--- a/src/b.js',
      '+++ b/src/b.js',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');

    const verifier = new DeterministicVerifier();
    const files = verifier.parseDiffFiles(diff);
    assert.strictEqual(files.length, 2);
    assert.strictEqual(files[0].path, 'src/a.js');
    assert.strictEqual(files[1].path, 'src/b.js');
  });

  it('handles diffs with only additions', () => {
    const diff = [
      '--- a/src/file.js',
      '+++ b/src/file.js',
      '@@ -1 +1,2 @@',
      ' const x = 1;',
      '+const y = 2;',
    ].join('\n');

    const verifier = new DeterministicVerifier();
    const files = verifier.parseDiffFiles(diff);
    assert.strictEqual(files.length, 1);
    assert.ok(files[0].content.includes('const y = 2;'));
    assert.ok(files[0].content.includes('const x = 1;'));
  });

  it('returns empty array for null diff', () => {
    const verifier = new DeterministicVerifier();
    const files = verifier.parseDiffFiles(null);
    assert.strictEqual(files.length, 0);
  });

  it('returns empty array for empty diff', () => {
    const verifier = new DeterministicVerifier();
    const files = verifier.parseDiffFiles('');
    assert.strictEqual(files.length, 0);
  });

  it('handles new file creation diffs', () => {
    const diff = [
      '--- /dev/null',
      '+++ b/src/new.js',
      '@@ -0,0 +1,2 @@',
      '+const a = 1;',
      '+const b = 2;',
    ].join('\n');

    const verifier = new DeterministicVerifier();
    const files = verifier.parseDiffFiles(diff);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].path, 'src/new.js');
    assert.strictEqual(files[0].content, 'const a = 1;\nconst b = 2;');
  });
});
