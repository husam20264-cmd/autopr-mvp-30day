import { Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';
import config from '../../config/default.js';

let appOctokit;

export function getGithubApp() {
  if (!appOctokit) {
    appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.github.appId,
        privateKey: config.github.privateKey,
      },
    });
  }
  return appOctokit;
}

export async function getInstallationOctokit(installationId) {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.github.appId,
      privateKey: config.github.privateKey,
      installationId,
    },
  });
}
