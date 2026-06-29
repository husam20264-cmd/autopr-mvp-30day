export const FIX_TYPES = {
  DEPENDENCY: 'dependency',
  LINT: 'lint',
  CI_FAILURE: 'ci_failure',
  TRIVIAL_BUG: 'trivial_bug',
};

export const FIX_LABELS = {
  [FIX_TYPES.DEPENDENCY]: 'deps: update outdated dependency',
  [FIX_TYPES.LINT]: 'style: fix lint/formatting issue',
  [FIX_TYPES.CI_FAILURE]: 'fix: resolve CI configuration failure',
  [FIX_TYPES.TRIVIAL_BUG]: 'fix: correct trivial bug pattern',
};

export const PIPELINE_STEPS = [
  'classify',
  'build_context',
  'generate_patch',
  'safety_check',
  'apply_patch',
  'create_pr',
];

export const PR_STATES = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
  REJECTED: 'rejected',
};
