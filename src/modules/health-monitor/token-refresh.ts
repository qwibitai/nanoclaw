import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';

const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

interface OauthFields {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  [key: string]: unknown;
}

/**
 * Attempts to refresh the OAuth access token for an agent group using the
 * stored refresh_token. Updates both claude.json and macOS Keychain on success.
 *
 * Returns:
 *   'refreshed'  — new token written, all good
 *   'failed'     — API call failed (refresh token likely expired; user must re-run claude login)
 *   'no-token'   — no claude.json or no refreshToken field found
 */
export async function tryRefreshOauthToken(agentGroupId: string): Promise<'refreshed' | 'failed' | 'no-token'> {
  const claudeJsonPath = path.join(DATA_DIR, 'v2-sessions', agentGroupId, 'claude.json');
  if (!fs.existsSync(claudeJsonPath)) return 'no-token';

  let fileData: Record<string, unknown>;
  let current: OauthFields | undefined;
  try {
    fileData = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    current = fileData?.claudeAiOauth as OauthFields | undefined;
  } catch {
    return 'no-token';
  }
  if (!current?.refreshToken) return 'no-token';

  let resp: Response;
  try {
    resp = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'claude-code/1.0' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: CLIENT_ID,
      }),
    });
  } catch (err) {
    log.warn('[health-monitor] Token refresh network error', { err, agentGroupId });
    return 'failed';
  }

  if (!resp.ok) {
    log.warn('[health-monitor] Token refresh rejected', { status: resp.status, agentGroupId });
    return 'failed';
  }

  let body: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    body = (await resp.json()) as typeof body;
  } catch {
    return 'failed';
  }
  if (!body.access_token) return 'failed';

  const newOauth: OauthFields = {
    ...current,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? current.refreshToken,
    expiresAt: Date.now() + (body.expires_in ?? 28_800) * 1_000,
  };

  // Update claude.json
  fileData.claudeAiOauth = newOauth;
  fs.writeFileSync(claudeJsonPath, JSON.stringify(fileData, null, 2));

  // Update Keychain so the next pre-spawn read gets the fresh token.
  // Pass the new JSON via env var to avoid any shell-quoting issues.
  try {
    const keychainRaw = execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" -w 2>/dev/null`, {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
    if (keychainRaw) {
      const keychainData = JSON.parse(keychainRaw);
      keychainData.claudeAiOauth = newOauth;
      execSync(
        `security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "${process.env.USER ?? 'files'}" -w "$KEYCHAIN_PWD" -U`,
        {
          encoding: 'utf8',
          timeout: 5_000,
          env: { ...process.env, KEYCHAIN_PWD: JSON.stringify(keychainData) },
        },
      );
    }
  } catch (err) {
    // Keychain update failure is non-fatal — claude.json is already updated.
    log.warn('[health-monitor] Keychain update after refresh failed', { err });
  }

  log.info('[health-monitor] OAuth token auto-refreshed', {
    agentGroupId,
    newExpiresAt: new Date(newOauth.expiresAt).toISOString(),
  });
  return 'refreshed';
}
