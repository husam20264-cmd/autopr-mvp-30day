import 'dotenv/config';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const args = process.argv.slice(2);
const command = args[0];

function run(cmd) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

switch (command) {
  case 'build':
    run('docker compose -f infra/deploy/docker-compose.yml build');
    break;

  case 'start':
    run('docker compose -f infra/deploy/docker-compose.yml up -d');
    console.log('AutoPR is running on port', process.env.PORT || 3000);
    break;

  case 'stop':
    run('docker compose -f infra/deploy/docker-compose.yml down');
    break;

  case 'logs':
    run('docker compose -f infra/deploy/docker-compose.yml logs -f');
    break;

  case 'init-db': {
    const { getDb } = await import('../data/db.js');
    getDb();
    console.log('Database initialized');
    break;
  }

  default:
    console.log(`
Usage: node scripts/deploy.js <command>

Commands:
  build       Build Docker images
  start       Start services in background
  stop        Stop services
  logs        Follow logs
  init-db     Initialize database
    `);
}
