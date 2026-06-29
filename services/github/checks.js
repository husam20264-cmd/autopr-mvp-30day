export async function getCheckRun(octokit, owner, repo, checkRunId) {
  const { data } = await octokit.rest.checks.get({ owner, repo, check_run_id: checkRunId });
  return data;
}

export async function getCheckSuitesForRef(octokit, owner, repo, ref) {
  const { data } = await octokit.rest.checks.listSuitesForRef({ owner, repo, ref });
  return data.check_suites;
}

export async function getLatestCommitStatus(octokit, owner, repo, branch) {
  const { data } = await octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: branch });
  return data;
}
