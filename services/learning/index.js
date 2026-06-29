import { logger } from '../../api/webhooks/index.js';

let memoryInstance;

export async function getLearningSystem() {
  if (!memoryInstance) {
    const { PatternMemory } = await import('./memory.js');
    memoryInstance = new PatternMemory();
  }
  return memoryInstance;
}

export async function tryMemoryFirst(fixType, context) {
  const m = await getLearningSystem();
  const result = m.findMatch(fixType, context);
  if (result.match) {
    logger.info({ fixType, source: result.source, confidence: result.confidence },
      'Memory hit — bypassing LLM');
  }
  return result;
}

export async function learnFromOutcome(pr, outcome, context) {
  const m = await getLearningSystem();
  const { fixType, diff, repo } = pr;

  if (outcome === 'accepted' || outcome === 'merged') {
    m.recordPattern(fixType, diff, { ...context, repo }, true);
    logger.info({ pr: pr.number, fixType, outcome }, 'Learned from accepted PR');
  } else if (outcome === 'rejected' || outcome === 'closed') {
    m.recordRejection(repo, fixType, outcome, diff, context);
    logger.info({ pr: pr.number, fixType, outcome }, 'Learned from rejected PR');
  }
}
