import pino from 'pino';
import config from '../../config/default.js';

const logger = pino({ level: config.logLevel });

export function safetyCheck(diff, context) {
  if (!diff) return { safe: false, reason: 'No diff generated' };

  if (diff.length > config.safety.maxDiffLength) {
    logger.warn({ diffLength: diff.length }, 'Diff exceeds max length');
    return { safe: false, reason: `Diff too large (${diff.length} > ${config.safety.maxDiffLength})` };
  }

  for (const pattern of config.safety.bannedPatterns) {
    if (pattern.test(diff)) {
      logger.warn({ pattern: pattern.toString() }, 'Banned pattern detected in diff');
      return { safe: false, reason: `Banned pattern detected: ${pattern}` };
    }
  }

  const changes = parseDiffStats(diff);
  if (changes.files > 5) {
    return { safe: false, reason: `Too many files changed (${changes.files} > 5)` };
  }
  if (changes.additions > 50) {
    return { safe: false, reason: `Too many additions (${changes.additions} > 50)` };
  }
  if (changes.deletions > 30) {
    return { safe: false, reason: `Too many deletions (${changes.deletions} > 30)` };
  }

  const repoName = context.repo?.toLowerCase() || '';
  if (repoName.includes('production') || repoName.includes('prod')) {
    return { safe: false, reason: 'Production repo detected — manual review required' };
  }

  return { safe: true };
}

function parseDiffStats(diff) {
  const files = new Set();
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('--- a/')) files.add(line.slice(6));
    if (line.startsWith('+++ b/')) files.add(line.slice(6));
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }

  return { files: files.size, additions, deletions };
}
