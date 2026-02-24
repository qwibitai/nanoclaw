/**
 * GitHub App Authentication
 * Manages JWT generation and installation token caching via @octokit/auth-app.
 * The private key lives at ~/.config/nanoclaw/github-app.pem (outside project root).
 * Containers only receive short-lived installation tokens, never the private key.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  appSlug?: string; // Populated after first API call
}

interface CachedToken {
  token: string;
  expiresAt: Date;
}

export class GitHubTokenManager {
  private config: GitHubAppConfig;
  private tokenCache = new Map<number, CachedToken>();
  private installationForRepo = new Map<string, number>();
  private appOctokit: Octokit;

  constructor(config: GitHubAppConfig) {
    this.config = config;
    this.appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.appId,
        privateKey: config.privateKey,
      },
    });
  }

  /** Get the app slug (login name like "nanoclaw-ai[bot]") */
  async getAppSlug(): Promise<string> {
    if (this.config.appSlug) return this.config.appSlug;
    const { data } = await this.appOctokit.apps.getAuthenticated();
    const slug = data?.slug ?? `app-${this.config.appId}`;
    this.config.appSlug = slug;
    return slug;
  }

  /** Get an installation token, cached with auto-refresh 5 min before expiry. */
  async getInstallationToken(installationId: number): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    if (cached && cached.expiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
      return cached.token;
    }

    const auth = createAppAuth({
      appId: this.config.appId,
      privateKey: this.config.privateKey,
      installationId,
    });

    const { token, expiresAt } = await auth({ type: 'installation' });
    this.tokenCache.set(installationId, {
      token,
      expiresAt: new Date(expiresAt),
    });

    return token;
  }

  /** Get an installation token for a specific repo. Looks up the installation first. */
  async getTokenForRepo(owner: string, repo: string): Promise<string> {
    const key = `${owner}/${repo}`;
    let installationId = this.installationForRepo.get(key);

    if (!installationId) {
      const { data } = await this.appOctokit.apps.getRepoInstallation({
        owner,
        repo,
      });
      installationId = data.id;
      this.installationForRepo.set(key, installationId);
    }

    return this.getInstallationToken(installationId);
  }

  /** Get an Octokit instance authenticated for a specific repo. */
  async getOctokitForRepo(owner: string, repo: string): Promise<Octokit> {
    const token = await this.getTokenForRepo(owner, repo);
    return new Octokit({ auth: token });
  }

  /** Get an Octokit instance authenticated for a specific installation. */
  async getOctokitForInstallation(installationId: number): Promise<Octokit> {
    const token = await this.getInstallationToken(installationId);
    return new Octokit({ auth: token });
  }

  get webhookSecret(): string {
    return this.config.webhookSecret;
  }
}

/**
 * Load GitHub App config from .env and private key file.
 * Returns null if GitHub App is not configured.
 */
export function loadGitHubAppConfig(): GitHubAppConfig | null {
  const env = readEnvFile([
    'GITHUB_APP_ID',
    'GITHUB_WEBHOOK_SECRET',
    'GITHUB_PRIVATE_KEY_PATH',
    'GITHUB_PRIVATE_KEY',
  ]);

  const appId = env.GITHUB_APP_ID;
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET;

  if (!appId || !webhookSecret) {
    return null;
  }

  // Private key: either inline in env or read from file
  let privateKey = env.GITHUB_PRIVATE_KEY;
  if (!privateKey) {
    const keyPath = env.GITHUB_PRIVATE_KEY_PATH ||
      path.join(os.homedir(), '.config', 'nanoclaw', 'github-app.pem');
    try {
      privateKey = fs.readFileSync(keyPath, 'utf-8');
    } catch {
      logger.error({ keyPath }, 'GitHub App private key not found');
      return null;
    }
  }

  return { appId, privateKey, webhookSecret };
}
