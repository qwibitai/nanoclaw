import { execFile } from 'child_process';
import path from 'path';
import { logger } from './logger.js';

export interface GmailRefreshResult {
  status: 'ok' | 'missing' | 'error';
  summary: string;
}

export interface GmailRefreshOptions {
  /** Override path to scripts/refresh-gmail-tokens.py (default: <cwd>/scripts/...) */
  scriptPath?: string;
  /** Maximum time to wait for the script to complete (ms). Default 15s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Refresh all Gmail account OAuth tokens by shelling out to
 * scripts/refresh-gmail-tokens.py. Safe to call before every container
 * spawn — fast no-op when nothing needs refresh.
 *
 * Never throws. All errors collapse to a structured GmailRefreshResult so
 * callers can decide whether to spawn the agent anyway (subject-only
 * classification is still better than no classification).
 */
export async function refreshGmailTokens(
  options: GmailRefreshOptions = {},
): Promise<GmailRefreshResult> {
  const scriptPath =
    options.scriptPath ||
    path.join(process.cwd(), 'scripts', 'refresh-gmail-tokens.py');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.warn(
        { scriptPath, timeoutMs },
        'gmail-token-refresh script timed out',
      );
      resolve({
        status: 'error',
        summary: `gmail-token-refresh timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    execFile(
      'python3',
      [scriptPath],
      { timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const summary = (stdout || stderr || '').trim();

        if (err) {
          const code = (err as { code?: number }).code;
          if (code === 2) {
            // Expected: at least one account is not yet authorized
            logger.debug({ summary }, 'gmail-token-refresh: missing accounts');
            resolve({ status: 'missing', summary });
            return;
          }
          if (code === 3) {
            logger.warn(
              { summary },
              'gmail-token-refresh: at least one refresh failed',
            );
            resolve({ status: 'error', summary });
            return;
          }
          // Script crashed (ENOENT, exec failure, etc.)
          logger.error(
            { err: err.message, summary },
            'gmail-token-refresh: script execution failed',
          );
          resolve({
            status: 'error',
            summary: summary || err.message,
          });
          return;
        }

        logger.debug({ summary }, 'gmail-token-refresh: all accounts ok');
        resolve({ status: 'ok', summary });
      },
    );
  });
}
