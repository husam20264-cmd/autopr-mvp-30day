export function buildTrustPRBody(justification, diff, fixType) {
  const trustBadge = {
    high: '✅ High Trust — Safe automated fix',
    medium: '⚠️ Medium Trust — Review recommended',
    low: '🔴 Low Trust — Manual review required',
  };

  const typeEmoji = {
    dependency: '📦',
    lint: '🧹',
    ci_failure: '🔧',
    trivial_bug: '🐛',
  };

  const body = [
    `## ${typeEmoji[fixType] || '🤖'} ${justification.summary}`,
    '',
    '---',
    '',
    '### 🔍 Change Analysis',
    '',
    '| Aspect | Detail | Risk |',
    '|---|---|---|',
    ...justification.riskAssessment.map(r =>
      `| ${r.label} | ${r.value} | ${riskEmoji(r.risk)} ${r.risk} |`
    ),
    '',
    '---',
    '',
    '### 📁 Scope',
    '',
    `**${justification.scopeExplanation.summary}**`,
    '',
    ...justification.scopeExplanation.files.map(f =>
      `- \`${f.path}\` (${f.changeType})`
    ),
    '',
    '---',
    '',
    '### 🛡️ Safety Verification',
    '',
    ...justification.safetyVerification.checks.map(c =>
      `- ${c.passed ? '✅' : '❌'} ${c.name}`
    ),
    '',
    justification.filesAvoided.note ? `> ${justification.filesAvoided.note}` : '',
    '',
    '---',
    '',
    `**${trustBadge[justification.trustLevel] || trustBadge.medium}**`,
    '',
    '```',
    ...(diff ? diff.split('\n').slice(0, 80) : ['(no diff)']),
    '```',
    '',
    '---',
    '',
    '<sub>🤖 AutoPR — Safe automated fixes for your repository. [Learn more](https://autopr.dev)</sub>',
  ];

  return body.join('\n');
}

function riskEmoji(level) {
  switch (level) {
    case 'low': return '🟢';
    case 'medium': return '🟡';
    case 'high': return '🔴';
    default: return '⚪';
  }
}
