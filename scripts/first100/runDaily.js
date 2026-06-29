#!/usr/bin/env node
import 'dotenv/config';
import { executeDailyPlaybook } from './playbook.js';
import { generateFirst100Report } from './generateReport.js';
import { logger } from '../../api/webhooks/index.js';

async function main() {
  const command = process.argv[2] || 'run';

  switch (command) {
    case 'run':
      logger.info('Running daily GTM playbook...');
      const result = await executeDailyPlaybook();
      console.log('\n✅ Daily playbook complete:');
      console.log(JSON.stringify(result, null, 2));
      break;

    case 'report':
      console.log(generateFirst100Report());
      break;

    case 'both':
      await executeDailyPlaybook();
      console.log(generateFirst100Report());
      break;

    default:
      console.log(`
Usage: node scripts/first100/runDaily.js [command]

Commands:
  run       Execute daily GTM playbook (find repos + send PRs)
  report    Generate first-100-repos report
  both      Run playbook then generate report
      `);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
