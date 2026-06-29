import { getFileContent, getDefaultBranchRef, getRepoTree, getDefaultBranch } from '../github/repo.js';

const RELEVANT_FILE_PATTERNS = {
  dependency: ['package.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Gemfile', 'pom.xml', 'build.gradle', '.csproj'],
  lint: ['.eslintrc*', '.prettierrc*', 'tsconfig.json', '.editorconfig', 'stylelint.config*'],
  ci_failure: ['.github/workflows/', '.circleci/', 'Jenkinsfile', '.gitlab-ci.yml', 'azure-pipelines.yml'],
  trivial_bug: ['*.js', '*.ts', '*.py', '*.java', '*.go', '*.rb', '*.php'],
};

export async function buildContext(octokit, owner, repo, fixType, eventPayload) {
  const defaultBranch = await getDefaultBranch(octokit, owner, repo);
  const headSha = await getDefaultBranchRef(octokit, owner, repo);
  const tree = await getRepoTree(octokit, owner, repo, headSha);

  let relevantFiles = [];
  const patterns = RELEVANT_FILE_PATTERNS[fixType] || [];

  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\./g, '\\.') + '$');
      relevantFiles.push(...tree.filter(f => regex.test(f)));
    } else {
      if (tree.includes(pattern)) relevantFiles.push(pattern);
    }
  }

  relevantFiles = [...new Set(relevantFiles)].slice(0, 15);

  const fileContents = {};
  for (const file of relevantFiles) {
    const content = await getFileContent(octokit, owner, repo, file, headSha);
    if (content) fileContents[file] = content;
  }

  const cwd = eventPayload.repository?.contents_url?.replace('{+path}', '') || '';

  return {
    owner,
    repo,
    defaultBranch,
    headSha,
    fileContents,
    relevantFiles,
    cwd,
    eventPayload,
  };
}
