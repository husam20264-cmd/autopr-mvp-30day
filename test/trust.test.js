import { describe, it } from 'node:test';
import assert from 'node:assert';
import { calculateTrustScore } from '../services/trust/scorer.js';
import { generateJustification } from '../services/trust/justification.js';
import { buildTrustPRBody } from '../services/trust/pr-body.js';
import { buildTrustContext, prepareTrustedPR } from '../services/trust/index.js';

describe('Trust Scorer', () => {
  it('scores a clean minimal diff as high trust', () => {
    const diff = '--- a/src/index.js\n+++ b/src/index.js\n@@ -1,3 +1,3 @@\n const x = 1;\n-const y = 2;\n+const y = 3;\n const z = 4;';
    const context = { repo: 'test/repo', hasCI: true };
    const result = calculateTrustScore(context, diff, 'lint');
    assert.strictEqual(result.level, 'high');
    assert.ok(result.score >= 0.7);
    assert.ok(Array.isArray(result.warnings));
  });

  it('scores large diffs lower', () => {
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`-line${i}`);
      lines.push(`+line${i}_modified`);
    }
    const diff = '--- a/file\n+++ b/file\n@@ -1,100 +1,100 @@\n' + lines.join('\n');
    const context = { repo: 'test/repo' };
    const result = calculateTrustScore(context, diff, 'trivial_bug');
    assert.ok(result.score < 0.7);
  });

  it('detects high-risk files', () => {
    const diff = '--- a/src/auth/login.js\n+++ b/src/auth/login.js\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;';
    const context = { repo: 'test/repo' };
    const result = calculateTrustScore(context, diff, 'trivial_bug');
    assert.ok(result.warnings.some(w => w.includes('sensitive')));
  });

  it('penalizes destructive patterns', () => {
    const diff = '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-something\n+DROP TABLE users';
    const context = { repo: 'test/repo' };
    const result = calculateTrustScore(context, diff, 'trivial_bug');
    assert.ok(result.score <= 0.65);
    assert.ok(result.warnings.length > 0);
  });

  it('dependency fixes get high confidence', () => {
    const diff = '--- a/package.json\n+++ b/package.json\n@@ -10,3 +10,3 @@\n-  "lodash": "^4.17.20",\n+  "lodash": "^4.17.21",\n   "express": "^4.18.0"';
    const context = { repo: 'test/repo' };
    const result = calculateTrustScore(context, diff, 'dependency');
    assert.ok(result.score >= 0.5);
  });
});

describe('Trust Justification', () => {
  it('generates complete justification object', () => {
    const diff = '--- a/src/index.js\n+++ b/src/index.js\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;';
    const trustScore = calculateTrustScore({ repo: 'test/repo' }, diff, 'lint');
    const justification = generateJustification(trustScore, diff, 'lint', { relevantFiles: ['src/index.js'] });

    assert.ok(justification.summary);
    assert.ok(Array.isArray(justification.riskAssessment));
    assert.ok(justification.riskAssessment.length > 0);
    assert.ok(justification.scopeExplanation);
    assert.ok(justification.filesAvoided);
    assert.ok(justification.safetyVerification);
    assert.ok(justification.safetyVerification.checks.length > 0);
  });

  it('safety verification has all required checks', () => {
    const diff = '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b';
    const trustScore = calculateTrustScore({ repo: 'test/repo' }, diff, 'lint');
    const justification = generateJustification(trustScore, diff, 'lint', { relevantFiles: ['file'] });

    const checkNames = justification.safetyVerification.checks.map(c => c.name);
    assert.ok(checkNames.includes('Destructive patterns'));
    assert.ok(checkNames.includes('File scope limits'));
    assert.ok(checkNames.includes('Diff size limits'));
  });
});

describe('Trust PR Body', () => {
  it('generates markdown PR body', () => {
    const diff = '--- a/src/index.js\n+++ b/src/index.js\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;';
    const trustScore = calculateTrustScore({ repo: 'test/repo' }, diff, 'lint');
    const justification = generateJustification(trustScore, diff, 'lint', { relevantFiles: ['src/index.js'] });
    const body = buildTrustPRBody(justification, diff, 'lint');

    assert.ok(body.includes('Change Analysis'));
    assert.ok(body.includes('Safety Verification'));
    assert.ok(body.includes('Scope'));
  });
});

describe('prepareTrustedPR', () => {
  it('rejects PR with very low trust score', () => {
    const diff = [
      '--- a/src/security/auth/payment.js',
      '+++ b/src/security/auth/payment.js',
      '@@ -1,130 +1,135 @@',
      ...Array.from({ length: 130 }, (_, i) => ` const line${i} = ${i};`),
      '-const target = 999;',
      '+rm -rf /',
      '+DROP TABLE users',
      '+eval(something)',
      '+process.exit(1)',
      '+EXEC(sp_configure)',
    ].flat().join('\n');
    const context = buildTrustContext({
      repo: 'test/repo',
      diff,
      hoursSinceLastPR: 1,
      previousAcceptedPRs: 0,
      previousTotalPRs: 5,
      hasCI: false,
    });
    const result = prepareTrustedPR(context, diff, 'trivial_bug');
    assert.strictEqual(result, null);
  });

  it('returns PR body for high trust changes', () => {
    const diff = '--- a/src/index.js\n+++ b/src/index.js\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;';
    const context = buildTrustContext({ repo: 'test/repo', diff });
    const result = prepareTrustedPR(context, diff, 'lint');
    assert.ok(result !== null);
    assert.ok(result.prBody.length > 0);
    assert.ok(result.trustScore.score > 0);
    assert.ok(result.shouldCreatePR);
  });
});
