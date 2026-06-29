import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyEvent } from '../services/classifier/index.js';
import { FIX_TYPES } from '../config/constants.js';

describe('classifyEvent', () => {
  it('classifies dependency update from push', () => {
    const result = classifyEvent('push', null, {
      ref: 'refs/heads/main',
      commits: [{ message: 'Update dependency lodash to v5' }],
    });
    assert.strictEqual(result, FIX_TYPES.DEPENDENCY);
  });

  it('classifies lint fix from push', () => {
    const result = classifyEvent('push', null, {
      ref: 'refs/heads/main',
      commits: [{ message: 'Fix eslint warnings' }],
    });
    assert.strictEqual(result, FIX_TYPES.LINT);
  });

  it('classifies CI failure from check_run', () => {
    const result = classifyEvent('check_run', 'completed', {
      check_run: { conclusion: 'failure' },
    });
    assert.strictEqual(result, FIX_TYPES.CI_FAILURE);
  });

  it('classifies trivial bug from issue', () => {
    const result = classifyEvent('issues', 'opened', {
      issue: { title: 'Null pointer exception in login', body: 'Getting null error' },
    });
    assert.strictEqual(result, FIX_TYPES.TRIVIAL_BUG);
  });

  it('returns null for non-actionable events', () => {
    const result = classifyEvent('issues', 'closed', {
      issue: { title: 'Some issue', body: 'Some body' },
    });
    assert.strictEqual(result, null);
  });
});
