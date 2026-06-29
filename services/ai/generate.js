import config from '../../config/default.js';
import { buildSystemPrompt, buildUserPrompt } from './prompts.js';
import { logger } from '../../api/webhooks/index.js';

export async function generatePatch(fixType, context) {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(fixType, context);

  const response = await callLLM(systemPrompt, userPrompt);
  const diff = parseDiff(response);

  logger.info({ fixType, hasDiff: !!diff, diffLength: diff?.length }, 'Patch generated');
  return diff;
}

export async function callLLM(systemPrompt, userPrompt) {
  if (config.llm.apiKey.startsWith('sk-')) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.llm.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.llm.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: config.llm.maxTokens,
        temperature: config.llm.temperature,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LLM API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  // Fallback: return a mock diff for dev/testing
  return generateMockDiff(context);
}

function parseDiff(text) {
  if (!text || text.includes('NO_FIX_POSSIBLE')) return null;

  const diffMatch = text.match(/```diff\n([\s\S]*?)```/);
  if (diffMatch) return diffMatch[1].trim();

  const diffLines = text.split('\n').filter(l =>
    l.startsWith('--- ') || l.startsWith('+++ ') || l.startsWith('@@ ') ||
    l.startsWith('+') || l.startsWith('-') || l.startsWith(' ')
  );
  if (diffLines.length > 3) return diffLines.join('\n');

  return null;
}

function generateMockDiff(context) {
  const files = Object.keys(context.fileContents);
  if (files.length === 0) return null;

  const file = files[0];
  const lines = context.fileContents[file]?.split('\n') || [];
  if (lines.length < 2) return null;

  const diffLine = Math.min(3, lines.length - 1);
  const oldLine = lines[diffLine - 1];
  const newLine = oldLine + ' // fixed';

  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${diffLine},1 +${diffLine},1 @@`,
    ` ${lines.slice(0, diffLine - 1).join('\n')}`,
    `-${oldLine}`,
    `+${newLine}`,
    ...lines.slice(diffLine).map(l => ` ${l}`),
  ].join('\n');
}
