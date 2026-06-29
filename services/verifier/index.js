import { execSync, exec } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const VERIFIER_TIMEOUT = parseInt(process.env.VERIFIER_TIMEOUT || '60000');

const BUILD_COMMANDS = {
  npm:   { detect: 'package.json',    typecheck: 'npx tsc --noEmit',           build: 'npm run build',     lint: 'npx eslint .' },
  yarn:  { detect: 'yarn.lock',       typecheck: 'yarn tsc --noEmit',          build: 'yarn build',        lint: 'yarn lint' },
  pnpm:  { detect: 'pnpm-lock.yaml',  typecheck: 'pnpm tsc --noEmit',          build: 'pnpm build',        lint: 'pnpm lint' },
  pip:   { detect: 'requirements.txt', typecheck: 'python -m py_compile',       build: null,                lint: 'flake8' },
  cargo: { detect: 'Cargo.toml',      typecheck: 'cargo check',                build: 'cargo build',       lint: 'cargo clippy' },
  go:    { detect: 'go.mod',          typecheck: 'go vet',                     build: 'go build',          lint: 'golangci-lint run' },
};

export class DeterministicVerifier {
  constructor() {
    this.tempDirs = [];
  }

  detectPackageManager(repoDir) {
    for (const [name, config] of Object.entries(BUILD_COMMANDS)) {
      try {
        const files = execSync(`ls ${join(repoDir, config.detect)} 2>/dev/null`, { timeout: 5000 });
        if (files.toString().trim()) return { name, config };
      } catch {}
    }
    return null;
  }

  async verify(repoUrl, branch, diff, fileContents) {
    const tempDir = mkdtempSync(join(tmpdir(), 'autopr-verify-'));
    this.tempDirs.push(tempDir);
    const results = { passed: false, checks: [], errors: [], summary: '' };

    try {
      execSync(`git clone --depth 1 --branch ${branch} ${repoUrl} ${tempDir} 2>/dev/null`, {
        timeout: 30000,
        stdio: 'pipe',
      });
    } catch (e) {
      // Try default branch
      try {
        execSync(`git clone --depth 1 ${repoUrl} ${tempDir} 2>/dev/null`, { timeout: 30000, stdio: 'pipe' });
      } catch (e2) {
        return { passed: false, checks: [], errors: ['clone_failed'], summary: 'Could not clone repository' };
      }
    }

    const pm = this.detectPackageManager(tempDir);
    if (!pm) {
      return { passed: true, checks: [], errors: [], summary: 'No supported package manager detected — skipping verification' };
    }

    const diffFiles = this.parseDiffFiles(diff);
    for (const { path, content } of diffFiles) {
      const fullPath = join(tempDir, path);
      try {
        writeFileSync(fullPath, content, 'utf-8');
      } catch {
        results.errors.push(`write_failed:${path}`);
      }
    }

    const checkResults = [];
    const checkList = ['typecheck', 'lint'].filter(cmd => pm.config[cmd]);
    for (const checkName of checkList) {
      const cmd = pm.config[checkName];
      try {
        execSync(cmd, { cwd: tempDir, timeout: VERIFIER_TIMEOUT, stdio: 'pipe' });
        checkResults.push({ name: checkName, passed: true, output: '' });
      } catch (e) {
        const output = e.stderr?.toString().slice(0, 1000) || e.message;
        checkResults.push({ name: checkName, passed: false, output });
        results.errors.push(`${checkName}_failed`);
      }
    }

    results.checks = checkResults;
    results.passed = results.errors.length === 0;
    results.summary = results.passed
      ? `All ${checkList.length} checks passed`
      : `Failed ${results.errors.length}/${checkList.length} checks: ${results.errors.join(', ')}`;

    return results;
  }

  parseDiffFiles(diff) {
    if (!diff) return [];
    const files = [];
    let currentFile = null;
    let currentContent = [];
    let isNewFile = false;

    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ b/')) {
        if (currentFile && isNewFile) {
          files.push({ path: currentFile, content: currentContent.join('\n') });
        }
        currentFile = line.slice(6);
        currentContent = [];
        isNewFile = false;
      } else if (line.startsWith('--- a/')) {
        if (currentFile && isNewFile) {
          files.push({ path: currentFile, content: currentContent.join('\n') });
        }
        currentFile = null;
        isNewFile = false;
      } else if (currentFile) {
        if (line.startsWith('-')) {
          // deletion — skip
        } else if (line.startsWith('+')) {
          currentContent.push(line.slice(1));
          isNewFile = true;
        } else if (line.startsWith(' ')) {
          currentContent.push(line.slice(1));
        }
      }
    }

    if (currentFile && isNewFile) {
      files.push({ path: currentFile, content: currentContent.join('\n') });
    }

    return files;
  }

  cleanup() {
    for (const dir of this.tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    this.tempDirs = [];
  }
}
