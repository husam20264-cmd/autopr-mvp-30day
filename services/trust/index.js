import { calculateTrustScore } from './scorer.js';
import { generateJustification } from './justification.js';
import { buildTrustPRBody } from './pr-body.js';

export function buildTrustContext({
  repo,
  repoStars,
  openIssues,
  hasCI,
  maintainerResponseRate,
  previousAcceptedPRs,
  previousTotalPRs,
  hoursSinceLastPR,
  relevantFiles,
  diff,
}) {
  return {
    repo,
    repoStars,
    openIssues,
    hasCI,
    maintainerResponseRate,
    previousAcceptedPRs,
    previousTotalPRs,
    hoursSinceLastPR,
    relevantFiles,
    diff,
  };
}

export function prepareTrustedPR(context, diff, fixType) {
  const trustScore = calculateTrustScore(context, diff, fixType);

  if (trustScore.score < 0.3) {
    return null;
  }

  const justification = generateJustification(trustScore, diff, fixType, context);
  const prBody = buildTrustPRBody(justification, diff, fixType);

  return {
    trustScore,
    justification,
    prBody,
    shouldCreatePR: trustScore.score >= 0.5,
    needsReview: trustScore.score < 0.7,
  };
}
