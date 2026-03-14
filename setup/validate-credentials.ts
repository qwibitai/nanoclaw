/**
 * Step: validate-credentials — Check if the provided Claude token is valid.
 */
import { readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  logger.info('Starting credentials validation');

  const envVars = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
  ]);

  const token = envVars.CLAUDE_CODE_OAUTH_TOKEN || envVars.ANTHROPIC_API_KEY;

  if (!token) {
    logger.info('No token found to validate (skipping)');
    emitStatus('VALIDATE_CREDENTIALS', {
      STATUS: 'success',
      SKIPPED: true,
      LOG: 'logs/setup.log',
    });
    return;
  }

  try {
    const headers: Record<string, string> = {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'user-agent': 'nanoclaw/1.0.0',
    };

    if (envVars.CLAUDE_CODE_OAUTH_TOKEN) {
      headers['authorization'] = `Bearer ${token}`;
    } else {
      headers['x-api-key'] = token;
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-latest',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    if (res.status === 401) {
      logger.error('Invalid bearer token or API key');
      emitStatus('VALIDATE_CREDENTIALS', {
        STATUS: 'failed',
        ERROR: 'Invalid bearer token',
      });
      return;
    }

    if (!res.ok && res.status !== 400) {
      const text = await res.text();
      logger.warn({ status: res.status, body: text }, 'Unexpected API response during validation');
    }

    emitStatus('VALIDATE_CREDENTIALS', {
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
  } catch (err) {
    logger.error({ err }, 'Failed to validate credentials network request');
    emitStatus('VALIDATE_CREDENTIALS', {
      STATUS: 'success',
      WARNING: 'Network error during validation',
      LOG: 'logs/setup.log',
    });
  }
}

