const TRUST_WEIGHTS = {
  repoHistory: { weight: 3, max: 1 },
  diffSize: { weight: 2.5, max: 1 },
  fileScope: { weight: 2, max: 1 },
  riskPatterns: { weight: 2.5, max: 1 },
  fixTypeConfidence: { weight: 2, max: 1 },
  maintainerResponsiveness: { weight: 1.5, max: 1 },
  previousAcceptance: { weight: 3, max: 1 },
  timeSinceLastPR: { weight: 1, max: 1 },
};

const HIGH_RISK_FILES = [
  /auth/, /security/, /password/, /token/, /credential/,
  /payment/, /billing/, /stripe/, /bank/,
  /database/, /schema/, /migration/,
  /encrypt/, /decrypt/,
  /admin/, /sudo/, /root/,
];

const HIGH_RISK_PATTERNS = [
  /rm\s+-rf/i,
  /DROP\s+(TABLE|DATABASE)/i,
  /DELETE\s+FROM/i,
  /TRUNCATE\s+/i,
  /ALTER\s+(TABLE|DATABASE)/i,
  /GRANT\s+|REVOKE\s+/i,
  /EXEC\s*\(/i,
  /sp_executesql/i,
  /eval\s*\(/i,
  /process\.exit/i,
  /localStorage|sessionStorage/i,
  /document\.write/i,
  /innerHTML\s*=/i,
];

export function calculateTrustScore(context, diff, fixType) {
  let score = 0;
  const signals = {};
  const warnings = [];

  // 1. Repo history & health
  const repoHistoryScore = scoreRepoHistory(context);
  score += repoHistoryScore * TRUST_WEIGHTS.repoHistory.weight;
  signals.repoHistory = repoHistoryScore;

  // 2. Diff size analysis
  const diffSizeScore = scoreDiffSize(diff);
  score += diffSizeScore * TRUST_WEIGHTS.diffSize.weight;
  signals.diffSize = diffSizeScore;

  // 3. File scope safety
  const fileScopeScore = scoreFileScope(diff);
  score += fileScopeScore * TRUST_WEIGHTS.fileScope.weight;
  signals.fileScope = fileScopeScore;
  if (fileScopeScore < 0.8) {
    warnings.push('touches potentially sensitive files');
  }

  // 4. Risk pattern detection
  const riskScore = scoreRiskPatterns(diff);
  score += riskScore * TRUST_WEIGHTS.riskPatterns.weight;
  signals.riskPatterns = riskScore;
  if (riskScore < 0.7) {
    warnings.push('contains risky code patterns');
  }

  // 5. Fix type confidence
  const fixConfidence = getFixTypeConfidence(fixType);
  score += fixConfidence * TRUST_WEIGHTS.fixTypeConfidence.weight;
  signals.fixTypeConfidence = fixConfidence;

  // 6. Maintainer behavior
  const maintScore = scoreMaintainer(context);
  score += maintScore * TRUST_WEIGHTS.maintainerResponsiveness.weight;
  signals.maintainerResponsiveness = maintScore;

  // 7. Previous acceptance
  const prevAccept = scorePreviousAcceptance(context);
  score += prevAccept * TRUST_WEIGHTS.previousAcceptance.weight;
  signals.previousAcceptance = prevAccept;

  // 8. Time since last PR (anti-spam)
  const timeScore = scoreTimeSinceLastPR(context);
  score += timeScore * TRUST_WEIGHTS.timeSinceLastPR.weight;
  signals.timeSinceLastPR = timeScore;

  const maxPossible = Object.entries(TRUST_WEIGHTS)
    .reduce((sum, [_, v]) => sum + v.weight * v.max, 0);
  const normalizedScore = Math.min(1, Math.max(0, score / maxPossible));

  const level = normalizedScore >= 0.75 ? 'high'
    : normalizedScore >= 0.5 ? 'medium'
    : 'low';

  return {
    score: Math.round(normalizedScore * 100) / 100,
    level,
    signals,
    warnings,
    breakdown: {
      numeric: Math.round(score * 10) / 10,
      maxPossible: Math.round(maxPossible * 10) / 10,
      components: Object.entries(signals).map(([key, val]) => ({
        name: key,
        score: val,
        weight: TRUST_WEIGHTS[key]?.weight || 1,
        contribution: Math.round(val * (TRUST_WEIGHTS[key]?.weight || 1) * 10) / 10,
      })),
    },
  };
}

function scoreRepoHistory(context) {
  const repo = context.repo || '';
  const stars = context.repoStars || 0;
  const issues = context.openIssues || 0;
  let score = 0.5;

  if (stars > 0) score += 0.1;
  if (issues > 0 && issues < 50) score += 0.2;
  if (context.hasCI) score += 0.2;

  return Math.min(1, score);
}

function scoreDiffSize(diff) {
  if (!diff) return 0;
  const lines = diff.split('\n').length;
  if (lines <= 10) return 1;
  if (lines <= 25) return 0.9;
  if (lines <= 50) return 0.7;
  if (lines <= 80) return 0.5;
  if (lines <= 120) return 0.3;
  return 0.1;
}

function scoreFileScope(diff) {
  if (!diff) return 0;
  const files = new Set();
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) files.add(line.slice(6));
  }

  if (files.size === 0) return 0;
  if (files.size > 3) return 0.3;

  let score = 1;
  for (const file of files) {
    for (const pattern of HIGH_RISK_FILES) {
      if (pattern.test(file)) {
        score -= 0.35;
      }
    }
  }

  return Math.max(0.1, score);
}

function scoreRiskPatterns(diff) {
  if (!diff) return 1;
  let matches = 0;
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(diff)) matches++;
  }
  return Math.max(0, 1 - matches * 0.4);
}

function getFixTypeConfidence(fixType) {
  const confidences = {
    dependency: 0.85,
    lint: 0.95,
    ci_failure: 0.8,
    trivial_bug: 0.75,
  };
  return confidences[fixType] || 0.5;
}

function scoreMaintainer(context) {
  const responseRate = context.maintainerResponseRate || 0;
  if (responseRate > 0.7) return 1;
  if (responseRate > 0.4) return 0.7;
  if (responseRate > 0.2) return 0.4;
  return 0.2;
}

function scorePreviousAcceptance(context) {
  const accepted = context.previousAcceptedPRs || 0;
  const total = context.previousTotalPRs || 0;
  if (total === 0) return 0.5;
  const rate = accepted / total;
  if (rate > 0.8) return 1;
  if (rate > 0.6) return 0.8;
  if (rate > 0.4) return 0.6;
  if (rate > 0.2) return 0.3;
  return 0.1;
}

function scoreTimeSinceLastPR(context) {
  const hoursSinceLast = context.hoursSinceLastPR || 48;
  if (hoursSinceLast > 72) return 1;
  if (hoursSinceLast > 48) return 0.8;
  if (hoursSinceLast > 24) return 0.6;
  if (hoursSinceLast > 6) return 0.3;
  return 0.1;
}
