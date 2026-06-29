export async function getRepoContent(octokit, owner, repo, path = '') {
  const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
  return data;
}

export async function getFileContent(octokit, owner, repo, path, ref) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data)) return null;
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

export async function getDefaultBranchRef(octokit, owner, repo) {
  const { data } = await octokit.rest.git.getRef({
    owner, repo, ref: 'heads/' + (await getDefaultBranch(octokit, owner, repo)),
  });
  return data.object.sha;
}

export async function getDefaultBranch(octokit, owner, repo) {
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return data.default_branch;
}

export async function getRepoTree(octokit, owner, repo, sha) {
  const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: sha, recursive: '1' });
  return data.tree.filter(t => t.type === 'blob').map(t => t.path);
}
