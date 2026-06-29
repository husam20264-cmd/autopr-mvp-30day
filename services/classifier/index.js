import { FIX_TYPES } from '../../config/constants.js';

export function classifyEvent(eventType, action, payload) {
  // Push event - check if it's a dependency update or CI config change
  if (eventType === 'push') {
    const ref = payload.ref?.replace('refs/heads/', '');
    const commits = payload.commits || [];
    const messages = commits.map(c => c.message?.toLowerCase() || '').join(' ');

    if (matchesDependency(messages, commits)) return FIX_TYPES.DEPENDENCY;
    if (matchesLint(messages, commits)) return FIX_TYPES.LINT;
  }

  // Check run completed - CI failure
  if (eventType === 'check_run' && action === 'completed') {
    const conclusion = payload.check_run?.conclusion;
    if (['failure', 'cancelled', 'timed_out', 'action_required'].includes(conclusion)) {
      return FIX_TYPES.CI_FAILURE;
    }
  }

  // Issue opened - trivial bug pattern
  if (eventType === 'issues' && action === 'opened') {
    const title = (payload.issue?.title || '').toLowerCase();
    const body = (payload.issue?.body || '').toLowerCase();

    if (matchesTrivialBug(title, body)) return FIX_TYPES.TRIVIAL_BUG;
  }

  // PR opened - could be any of the above
  if (eventType === 'pull_request' && action === 'opened') {
    const title = (payload.pull_request?.title || '').toLowerCase();
    const body = (payload.pull_request?.body || '').toLowerCase();

    if (matchesDependency(title, [{ message: body }])) return FIX_TYPES.DEPENDENCY;
    if (matchesLint(title, [{ message: body }])) return FIX_TYPES.LINT;
    if (matchesTrivialBug(title, body)) return FIX_TYPES.TRIVIAL_BUG;
  }

  return null;
}

function matchesDependency(combined, commits) {
  const depsPatterns = [
    /outdated|update.*dep|dependabot|renovate|package\.json/i,
    /bump|upgrade.*(?:dep|package|module)/i,
    /dependency.*version/i,
    /yarn\.lock|package-lock\.json|pnpm-lock\.yaml/i,
  ];
  return depsPatterns.some(p => p.test(combined));
}

function matchesLint(combined, commits) {
  const lintPatterns = [
    /lint|eslint|prettier|format|stylelint/i,
    /formatting|whitespace|indent|semicolon/i,
    /\.eslintrc|\.prettierrc|tslint/i,
    /trailing.*comma|missing.*space/i,
  ];
  return lintPatterns.some(p => p.test(combined));
}

function matchesTrivialBug(title, body) {
  const bugPatterns = [
    /null.*pointer|null.*reference|undefined.*error/i,
    /typo|misspell|wrong.*variable/i,
    /broken.*link|dead.*link|404/i,
    /missing.*import|wrong.*import/i,
    /false.*positive|incorrect.*check/i,
    /console.*log|debug.*left|debug.*statement/i,
    /wrong.*argument|wrong.*param/i,
    /deprecated.*api|deprecated.*call/i,
  ];
  return bugPatterns.some(p => p.test(title) || p.test(body));
}
