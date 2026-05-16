import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import { getAllAgentGroups } from '../../db/agent-groups.js';
import { upsertTokenStatus } from '../../db/token-status.js';
import { DATA_DIR } from '../../config.js';
import { refreshOauthTokenIfNeeded } from '../../oauth-token-refresh.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { postAlert } from './alert.js';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export interface TokenSweepResult {
  agentGroupId: string;
  status: 'ok' | 'refreshed' | 'failed' | 'no-token';
  minutesLeft: number | null;
}

// Read once per sweep — all groups share the same Keychain entry.
function readKeychainOauth(): Record<string, unknown> | null {
  try {
    const raw = execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" -w 2>/dev/null`, {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
    if (!raw) return null;
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    return oauth?.refreshToken ? (oauth as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Writes Keychain OAuth credentials into claude.json, but only when the
 * Keychain token is newer. This guards against overwriting a just-refreshed
 * file with the stale snapshot taken at sweep start.
 */
function syncOauthToFile(claudeJsonPath: string, oauth: Record<string, unknown>): void {
  if (!fs.existsSync(claudeJsonPath)) return;
  try {
    const fileData = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    const fileExpiry = (fileData?.claudeAiOauth?.expiresAt as number | undefined) ?? 0;
    const keychainExpiry = (oauth.expiresAt as number | undefined) ?? 0;
    if (keychainExpiry <= fileExpiry) return;
    fileData.claudeAiOauth = oauth;
    fs.writeFileSync(claudeJsonPath, JSON.stringify(fileData, null, 2));
  } catch {
    // Non-fatal — sweep proceeds with whatever is in claude.json
  }
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
 * Checks OAuth tokens for all agent groups. Groups with tokens expiring
 * within the threshold are refreshed automatically. Results are written
 * to the token_status table and returned for alerting.
 *
 * Reads the macOS Keychain once per sweep (all groups share one entry) and
 * syncs each group's claude.json before the refresh attempt, ensuring any
 * token rotation from a previous group or external process is visible.
 *
 * When a token is refreshed, any running container for that group is
 * restarted so it picks up the new token from the mounted claude.json.
 * A Discord notification is sent on restart.
 *
 * Skips the health-monitor group itself (no claude.json).
 */
export async function sweepAllTokens(): Promise<TokenSweepResult[]> {
  const results: TokenSweepResult[] = [];

  const keychainOauth = readKeychainOauth();

  for (const group of getAllAgentGroups()) {
    if (group.id === 'health-monitor') continue;

    const claudeJsonPath = path.join(DATA_DIR, 'v2-sessions', group.id, 'claude.json');

    if (keychainOauth) syncOauthToFile(claudeJsonPath, keychainOauth);

    const raw = await refreshOauthTokenIfNeeded(claudeJsonPath, `[token-sweep:${group.id}]`);
    const status: TokenSweepResult['status'] = raw === 'not-needed' ? 'ok' : raw;

    if (raw === 'refreshed') {
      const restarted = restartAgentGroupContainers(group.id, 'token-refresh');
      if (restarted > 0) {
        await postAlert(
          `🔄 **OAuth token refreshed** — \`${group.id}\`. Running container restarted to pick up new token. ` +
            `Any in-progress task will be retried on the next wake.`,
        );
      }
    }

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
