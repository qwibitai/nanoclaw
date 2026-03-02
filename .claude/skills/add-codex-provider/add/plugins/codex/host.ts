/**
 * Codex Provider Plugin — Host Module
 *
 * Implements the NanoClaw ProviderPlugin interface using the codex-oauth package.
 * Handles OAuth PKCE authentication and provides secrets to the container.
 *
 * This module runs on the host (not inside the container). NanoClaw's plugin
 * loader discovers it at startup and calls getSecrets() before each container spawn.
 *
 * Authentication flow:
 *   1. User runs setup (interactive OAuth PKCE via browser)
 *   2. Tokens are stored locally at DATA_DIR/codex-tokens.json
 *   3. On each container spawn, getSecrets() returns fresh access_token + account_id
 *   4. Container provider receives these via stdin JSON (never env vars)
 *
 * @requires codex-oauth - OAuth PKCE authentication package
 */

import { exec } from 'node:child_process';
import path from 'path';

import { CodexAuth } from 'codex-oauth';

// NanoClaw imports — adjust paths if installing as a standalone package
import { DATA_DIR } from '../../src/config.js';
import { logger } from '../../src/logger.js';
import type { ProviderPlugin } from './types.js';

/** Auto-open a URL in the system browser */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start ""'
        : 'xdg-open';
  exec(`${cmd} "${url}"`, (err) => {
    if (err) {
      logger.warn('Could not open browser automatically. Please open the URL manually.');
    }
  });
}

// Store tokens alongside other NanoClaw data
const CODEX_TOKENS_PATH = path.resolve(DATA_DIR, 'codex-tokens.json');
const auth = new CodexAuth({
  tokenPath: CODEX_TOKENS_PATH,
  onAuthUrl: openBrowser,
});

const plugin: ProviderPlugin = {
  name: 'codex',

  /**
   * Provide fresh OAuth tokens as container secrets.
   * Called by NanoClaw's container-runner before each container spawn.
   * Tokens are auto-refreshed if expired (handled by codex-oauth).
   */
  async getSecrets(): Promise<Record<string, string>> {
    const tokens = auth.getTokensSync();
    if (!tokens) return {};

    try {
      const fresh = await auth.getTokens();
      return {
        CODEX_ACCESS_TOKEN: fresh.access_token,
        CODEX_ACCOUNT_ID: fresh.account_id,
      };
    } catch (err) {
      logger.error({ err }, 'Codex token refresh failed');
      return {};
    }
  },

  /**
   * Check if Codex OAuth tokens exist.
   * Returns true if a refresh token is available (can obtain fresh access tokens).
   */
  isAuthenticated() {
    const tokens = auth.getTokensSync();
    return !!(tokens?.refresh_token);
  },

  /**
   * Interactive OAuth PKCE setup flow.
   * Opens browser for ChatGPT login, receives callback on localhost:1455.
   */
  async setup() {
    logger.info('Starting Codex OAuth PKCE flow');
    await auth.login();
    logger.info('Codex OAuth tokens saved');
  },

  /** Container-side provider file (copied into container at runtime) */
  containerProvider: 'provider-codex.ts',
};

export default plugin;
