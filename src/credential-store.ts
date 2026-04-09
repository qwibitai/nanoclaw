import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { platform, homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from './logger.js';

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch milliseconds
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_ACCOUNT = 'default';

/**
 * Parse raw credential JSON and extract the claudeAiOauth object.
 * Returns null if accessToken or refreshToken is missing.
 */
function parseCredentialJson(raw: string): OAuthCredentials | null {
  try {
    const data = JSON.parse(raw);
    const oauth = data?.claudeAiOauth;
    if (
      !oauth ||
      typeof oauth.accessToken !== 'string' ||
      typeof oauth.refreshToken !== 'string'
    ) {
      return null;
    }
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      scopes: oauth.scopes ?? [],
      subscriptionType: oauth.subscriptionType,
      rateLimitTier: oauth.rateLimitTier,
    };
  } catch {
    return null;
  }
}

/** Get the path to the Linux credential file. */
function linuxCredentialPath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

/** Read raw JSON string from the platform credential store. */
function readRawJson(): string | null {
  if (platform() === 'darwin') {
    try {
      const raw = execSync(
        `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
        { encoding: 'utf-8' },
      );
      return raw.trim();
    } catch (err) {
      logger.warn({ err }, 'Failed to read credentials from macOS keychain');
      return null;
    }
  }

  // Linux
  const credPath = linuxCredentialPath();
  if (!existsSync(credPath)) {
    logger.warn({ path: credPath }, 'Credential file not found');
    return null;
  }
  try {
    return readFileSync(credPath, 'utf-8');
  } catch (err) {
    logger.warn({ err, path: credPath }, 'Failed to read credential file');
    return null;
  }
}

/** Read OAuth credentials from the platform credential store. */
export function readCredentials(): OAuthCredentials | null {
  const raw = readRawJson();
  if (!raw) return null;

  const creds = parseCredentialJson(raw);
  if (!creds) {
    logger.warn(
      'Credential JSON parsed but missing required fields (accessToken/refreshToken)',
    );
  }
  return creds;
}

/** Write updated OAuth credentials back to the platform credential store. Preserves non-OAuth fields (e.g. mcpOAuth). */
export function writeCredentials(creds: OAuthCredentials): void {
  // Read existing data to preserve other fields
  let existing: Record<string, unknown> = {};
  const raw = readRawJson();
  if (raw) {
    try {
      existing = JSON.parse(raw);
    } catch {
      logger.warn('Could not parse existing credential JSON; overwriting');
    }
  }

  // Merge into claudeAiOauth, preserving extra fields within it
  existing.claudeAiOauth = {
    ...(existing.claudeAiOauth && typeof existing.claudeAiOauth === 'object'
      ? existing.claudeAiOauth
      : {}),
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
    scopes: creds.scopes,
    ...(creds.subscriptionType !== undefined && {
      subscriptionType: creds.subscriptionType,
    }),
    ...(creds.rateLimitTier !== undefined && {
      rateLimitTier: creds.rateLimitTier,
    }),
  };

  const json = JSON.stringify(existing);

  if (platform() === 'darwin') {
    try {
      execSync(`security delete-generic-password -s "${KEYCHAIN_SERVICE}"`, {
        stdio: 'ignore',
      });
    } catch {
      // Entry may not exist yet; that's fine
    }
    execSync(
      `security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -w '${json.replace(/'/g, "'\\''")}'`,
    );
  } else {
    // Linux
    const credPath = linuxCredentialPath();
    mkdirSync(join(credPath, '..'), { recursive: true });
    writeFileSync(credPath, json, { mode: 0o600 });
  }
}
