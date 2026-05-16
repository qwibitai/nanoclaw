import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import { getAllAgentGroups } from '../../db/agent-groups.js';
import { upsertTokenStatus } from '../../db/token-status.js';
import { DATA_DIR } from '../../config.js';
import { refreshOauthTokenIfNeeded } from '../../oauth-token-refresh.js';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export interface TokenSweepResult {
  agentGroupId: string;
  status: 'ok' | 'refreshed' | 'failed' | 'no-token';
  minutesLeft: number | null;
}

function readMinutesLeft(claudeJsonPath: string): { minutesLeft: number | null; expiresAt: number | null } {
  try {
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    const expiresAt = data?.claudeAiOauth?.expiresAt as number | undefined;
    if (!expiresAt) return { minutesLeft: null, expiresAt: null };
    return { minutesLeft: Math.floor((expiresAt - Date.now()) / 60_000), expiresAt };
  } catch {
    return { minutesLeft: null, expiresAt: null };
  }
}

/**
 * Syncs claude.json's OAuth credentials from the macOS Keychain.
 * Called before every refresh attempt so that any token rotation by a previous
 * group (or an external process) is picked up before we try the refresh_token.
 */
function syncFromKeychain(claudeJsonPath: string): void {
  if (!fs.existsSync(claudeJsonPath)) return;
  try {
    const raw = execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" -w 2>/dev/null`, {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
    if (!raw) return;
    const keychainData = JSON.parse(raw);
    const newOauth = keychainData?.claudeAiOauth;
    if (!newOauth?.refreshToken) return;
    const fileData = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    fileData.claudeAiOauth = newOauth;
    fs.writeFileSync(claudeJsonPath, JSON.stringify(fileData, null, 2));
  } catch {
    // Non-fatal — sweep will proceed with whatever is in claude.json
  }
}

/**
 * Checks OAuth tokens for all agent groups. Groups with tokens expiring
 * within the threshold are refreshed automatically. Results are written
 * to the token_status table and returned for alerting.
 *
 * Before each refresh attempt, syncs the group's claude.json from Keychain
 * so any token rotation by a previous group (or external process) is visible.
 *
 * Skips the health-monitor group itself (no claude.json).
 */
export async function sweepAllTokens(): Promise<TokenSweepResult[]> {
  const results: TokenSweepResult[] = [];

  for (const group of getAllAgentGroups()) {
    if (group.id === 'health-monitor') continue;

    const claudeJsonPath = path.join(DATA_DIR, 'v2-sessions', group.id, 'claude.json');

    syncFromKeychain(claudeJsonPath);

    const raw = await refreshOauthTokenIfNeeded(claudeJsonPath, `[token-sweep:${group.id}]`);
    const status: TokenSweepResult['status'] = raw === 'not-needed' ? 'ok' : raw;

    const { minutesLeft, expiresAt } = readMinutesLeft(claudeJsonPath);

    upsertTokenStatus({
      agentGroupId: group.id,
      checkedAt: Date.now(),
      expiresAt,
      minutesLeft,
      status,
    });

    results.push({ agentGroupId: group.id, status, minutesLeft });
  }

  return results;
}
