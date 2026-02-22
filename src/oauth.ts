import { execFile } from 'child_process';
import path from 'path';

import { logger } from './logger.js';

export const AUTH_ERROR_PATTERN = /401|unauthorized|authentication|token.*expired|invalid.*token|expired.*token/i;

export function refreshOAuthToken(): Promise<boolean> {
  const script = path.join(process.cwd(), 'scripts', 'refresh-oauth.sh');
  return new Promise((resolve) => {
    execFile(script, (err) => {
      if (err) {
        logger.error({ err }, 'OAuth refresh script failed');
        resolve(false);
      } else {
        logger.info('OAuth token refreshed after auth error');
        resolve(true);
      }
    });
  });
}
