import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

export interface GmailRefreshResult {
  status: 'ok' | 'missing' | 'error';
  summary: string;
}

export interface GmailRefreshOptions {
  /** Override path to scripts/refresh-gmail-tokens.py. Default is anchored to
   *  this module's location, NOT process.cwd(), so it works regardless of
   *  where the host service was launched from. */
  scriptPath?: string;
  /** Maximum time to wait for the script to complete (ms). Default 15s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

// Anchor the default script path to this module's location, not process.cwd().
// At runtime this resolves to <project>/dist/gmail-token-refresh.js, so the
// script lives one level up at <project>/scripts/refresh-gmail-tokens.py.
// This survives launchers that don't set cwd to the repo root (systemd,
// future Docker entrypoints, ad-hoc `node dist/index.js` invocations).
const DEFAULT_SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'refresh-gmail-tokens.py',
);

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
  const scriptPath = options.scriptPath || DEFAULT_SCRIPT_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    // Single source of truth for timeout: execFile's built-in `timeout` option.
    // When it fires, Node SIGTERMs the child process (preventing a zombie) and
    // then invokes the callback with err.killed=true, err.signal='SIGTERM'. We
    // detect that below and map it to a timeout result. Previously we also had
    // a wrapper setTimeout, which raced with execFile's timer and could cause
    // a misleading 'script crashed' log when execFile's kill fired first.
    execFile(
      'python3',
      [scriptPath],
      { timeout: timeoutMs },
      (err, stdout, stderr) => {
        const summary = (stdout || stderr || '').trim();

        if (err) {
          const killed = (err as { killed?: boolean }).killed === true;
          const signal = (err as { signal?: string }).signal;
          if (killed || signal === 'SIGTERM') {
            logger.warn(
              { scriptPath, timeoutMs },
              'gmail-token-refresh script timed out',
            );
            resolve({
              status: 'error',
              summary: `gmail-token-refresh timed out after ${timeoutMs}ms`,
            });
            return;
          }

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
