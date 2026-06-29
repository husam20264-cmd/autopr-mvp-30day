export function generateJustification(trustScore, diff, fixType, context) {
  const summary = generateSummary(trustScore, fixType);
  const riskAssessment = generateRiskAssessment(trustScore, diff);
  const scopeExplanation = generateScopeExplanation(diff);
  const filesAvoided = identifyAvoidedFiles(context);
  const safetyVerification = generateSafetyVerification(trustScore);

  return {
    summary,
    riskAssessment,
    scopeExplanation,
    filesAvoided,
    safetyVerification,
    trustScore: trustScore.score,
    trustLevel: trustScore.level,
    timestamp: new Date().toISOString(),
  };
}

function generateSummary(trustScore, fixType) {
  const label = {
    dependency: 'Dependency version update',
    lint: 'Code style / formatting fix',
    ci_failure: 'CI configuration fix',
    trivial_bug: 'Bug fix (low complexity)',
  };

  const trustNote = trustScore.score >= 0.7
    ? 'High confidence — safe automated fix'
    : trustScore.score >= 0.5
      ? 'Medium confidence — review recommended'
      : 'Low confidence — manual review required';

  return `${label[fixType] || 'Automated fix'}. ${trustNote}.`;
}

function generateRiskAssessment(trustScore, diff) {
  const items = [];

  const lineCount = diff ? diff.split('\n').filter(l => l.startsWith('+') || l.startsWith('-')).length : 0;
  items.push({
    type: 'diff_size',
    label: 'Changes',
    value: `${lineCount} lines`,
    risk: lineCount <= 20 ? 'low' : lineCount <= 50 ? 'medium' : 'high',
  });

  const filesChanged = diff ? new Set(
    diff.split('\n').filter(l => l.startsWith('+++ b/')).map(l => l.slice(6))
  ).size : 0;
  items.push({
    type: 'files_changed',
    label: 'Files modified',
    value: `${filesChanged} file(s)`,
    risk: filesChanged <= 1 ? 'low' : filesChanged <= 3 ? 'medium' : 'high',
  });

  items.push({
    type: 'trust_level',
    label: 'Trust level',
    value: trustScore.level.toUpperCase(),
    risk: trustScore.score >= 0.7 ? 'low' : trustScore.score >= 0.5 ? 'medium' : 'high',
  });

  const hasWarnings = trustScore.warnings.length > 0;
  if (hasWarnings) {
    items.push({
      type: 'warnings',
      label: 'Warnings',
      value: trustScore.warnings.join('; '),
      risk: 'medium',
    });
  }

  return items;
}

function generateScopeExplanation(diff) {
  if (!diff) return [];

  const files = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      files.push({
        path: line.slice(6),
        changeType: classifyChange(line.slice(6)),
      });
    }
  }

  return {
    totalFiles: files.length,
    files,
    summary: files.length === 1
      ? `Change is contained to a single file (${files[0].path}) — low risk of side effects.`
      : `Change spans ${files.length} files — moderate coordination risk.`,
  };
}

function classifyChange(filePath) {
  if (/\.(json|yaml|yml|toml|ini|cfg)$/.test(filePath)) return 'configuration';
  if (/\.(test|spec|e2e|cy)\./.test(filePath)) return 'test';
  if (/\.(md|txt|rst|adoc)$/.test(filePath)) return 'documentation';
  if (/\.(css|scss|less)$/.test(filePath)) return 'style';
  if (/\.(js|ts|jsx|tsx|py|rb|java|go|rs)$/.test(filePath)) return 'source';
  if (/Dockerfile|docker-compose/.test(filePath)) return 'infrastructure';
  if (/Makefile|Justfile|Taskfile/.test(filePath)) return 'build';
  return 'other';
}

function identifyAvoidedFiles(context) {
  const allFiles = context.relevantFiles || [];
  const changedFiles = new Set();

  // Extract changed file paths from diff
  if (context.diff) {
    for (const line of context.diff.split('\n')) {
      if (line.startsWith('+++ b/')) changedFiles.add(line.slice(6));
    }
  }

  const avoided = allFiles.filter(f => !changedFiles.has(f));
  const sensitiveAvoided = avoided.filter(f =>
    /auth|security|password|payment|database|schema|migration/.test(f)
  );

  return {
    totalAvailable: allFiles.length,
    changedCount: changedFiles.size,
    avoidedCount: avoided.length,
    sensitiveProtected: sensitiveAvoided.length,
    note: sensitiveAvoided.length > 0
      ? `Safe: ${sensitiveAvoided.length} sensitive file(s) explicitly excluded from changes.`
      : 'No sensitive files present in scope.',
  };
}

function generateSafetyVerification(trustScore) {
  const checks = [
    {
      name: 'Destructive patterns',
      passed: !trustScore.warnings.some(w => w.includes('destructive') || w.includes('delete')),
    },
    {
      name: 'File scope limits',
      passed: trustScore.signals.fileScope >= 0.5,
    },
    {
      name: 'Diff size limits',
      passed: trustScore.signals.diffSize >= 0.4,
    },
    {
      name: 'No sensitive files',
      passed: !trustScore.warnings.some(w => w.includes('sensitive')),
    },
  ];

  return {
    allPassed: checks.every(c => c.passed),
    passedCount: checks.filter(c => c.passed).length,
    totalCount: checks.length,
    checks,
  };
}
