import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import type { RemoteLogSource, UserProfile } from './types.js';

const VALID_USERNAME = /^[a-zA-Z0-9._-]+$/;
const VALID_HOST = /^[a-zA-Z0-9._:-]+$/;
const INJECTION_CHARS = /[';]/;

const TEMP_BASE = '/tmp/nanoclaw-logs';

/**
 * Returns the deterministic temp directory path for synced logs.
 */
export function buildTempDir(profileId: string, sourceName: string): string {
  return path.join(TEMP_BASE, profileId, sourceName);
}

/**
 * Builds an SSH command to find today's log files on a remote machine.
 * Validates all inputs to prevent command injection.
 */
export function buildSyncCommand(
  username: string,
  host: string,
  logPath: string,
  pattern: string,
): string {
  if (!VALID_USERNAME.test(username)) {
    throw new Error('Invalid username');
  }
  if (!VALID_HOST.test(host)) {
    throw new Error('Invalid host');
  }
  if (INJECTION_CHARS.test(logPath)) {
    throw new Error('Invalid logPath');
  }
  if (INJECTION_CHARS.test(pattern)) {
    throw new Error('Invalid pattern');
  }

  return `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new ${username}@${host} "find '${logPath}' -maxdepth 1 -name '${pattern}' -newermt 'today 00:00' -type f"`;
}

/**
 * Splits find output by newlines, trims, and filters empty lines.
 */
export function parseFindOutput(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Syncs today's logs from a single remote source.
 * Returns the local temp dir path, or null on failure.
 */
export function syncRemoteLogs(
  profile: UserProfile,
  source: RemoteLogSource,
): string | null {
  const tempDir = buildTempDir(profile.id, source.name);

  try {
    fs.mkdirSync(tempDir, { recursive: true });

    const sshCmd = buildSyncCommand(
      profile.linuxUsername,
      source.host,
      source.logPath,
      source.logPattern,
    );

    const findOutput = execSync(`sudo -u ${profile.linuxUsername} ${sshCmd}`, {
      timeout: 30_000,
      encoding: 'utf-8',
    });

    const files = parseFindOutput(findOutput);

    if (files.length === 0) {
      logger.info(
        { source: source.name, host: source.host },
        'No log files found for today',
      );
      return tempDir;
    }

    // SCP each file to the temp dir
    for (const remoteFile of files) {
      try {
        const scpCmd = `sudo -u ${profile.linuxUsername} scp -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new ${profile.linuxUsername}@${source.host}:"${remoteFile}" "${tempDir}/"`;
        execSync(scpCmd, { timeout: 60_000 });
      } catch (err) {
        logger.warn(
          { source: source.name, file: remoteFile, err },
          'Failed to SCP file',
        );
      }
    }

    logger.info(
      { source: source.name, host: source.host, fileCount: files.length },
      'Synced remote logs',
    );

    return tempDir;
  } catch (err) {
    logger.error(
      { source: source.name, host: source.host, err },
      'Failed to sync remote logs',
    );
    return null;
  }
}

/**
 * Syncs today's logs from all remote sources in a user profile.
 * Returns a map of source name to local temp dir path.
 */
export function syncAllRemoteLogs(
  profile: UserProfile,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const source of profile.remoteSources) {
    const dir = syncRemoteLogs(profile, source);
    if (dir) {
      result[source.name] = dir;
    }
  }

  return result;
}

/**
 * Deletes the synced logs temp directory for a profile.
 * Called after container exits. Uses fs.rmSync with recursive + force.
 */
export function cleanupSyncedLogs(profileId: string): void {
  const dir = path.join(TEMP_BASE, profileId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.info({ profileId, dir }, 'Cleaned up synced logs');
  } catch (err) {
    logger.warn({ profileId, dir, err }, 'Failed to clean up synced logs');
  }
}
