/**
 * Step: validate-credentials — Make a live API call to verify the Claude token works.
 *
 * Catches invalid, expired, or malformed tokens immediately after they are
 * written to .env, before the user proceeds with channel setup.
 *
 * Auth modes:
 *   API key  (ANTHROPIC_API_KEY):      sends x-api-key header
 *   OAuth    (CLAUDE_CODE_OAUTH_TOKEN): sends Authorization: Bearer header
 *
 * A 401 response means the token is rejected. Any other response (including
 * 400 bad-request) means authentication succeeded.
 */
import https from 'https';

import { readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

const ANTHROPIC_API_HOST = 'api.anthropic.com';
const ANTHROPIC_API_VERSION = '2023-06-01';
// Cheapest model, 1 token — we only care about the HTTP status code.
const PROBE_MODEL = 'claude-haiku-4-5-20251001';

function probe(headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: ANTHROPIC_API_HOST,
        path: '/v1/messages',
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function run(_args: string[]): Promise<void> {
  logger.info('Validating Claude credentials');

  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);

  const apiKey = secrets.ANTHROPIC_API_KEY;
  const oauthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  if (!apiKey && !oauthToken) {
    emitStatus('VALIDATE_CREDENTIALS', {
      VALID: false,
      AUTH_MODE: 'none',
      ERROR: 'no_credentials',
      STATUS: 'failed',
    });
    process.exit(1);
  }

  const authMode = apiKey ? 'api-key' : 'oauth';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_API_VERSION,
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  } else {
    headers['authorization'] = `Bearer ${oauthToken}`;
  }

  const body = JSON.stringify({
    model: PROBE_MODEL,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  });

  let httpStatus: number;
  try {
    httpStatus = await probe(headers, body);
  } catch (err) {
    logger.error({ err }, 'Network error during credential validation');
    emitStatus('VALIDATE_CREDENTIALS', {
      VALID: false,
      AUTH_MODE: authMode,
      ERROR: 'network_error',
      STATUS: 'failed',
    });
    process.exit(1);
  }

  // 401 = bad credentials. Everything else (200, 400, 529 …) means auth passed.
  const valid = httpStatus !== 401;

  logger.info({ authMode, httpStatus, valid }, 'Credential validation result');

  emitStatus('VALIDATE_CREDENTIALS', {
    VALID: valid,
    AUTH_MODE: authMode,
    HTTP_STATUS: httpStatus,
    STATUS: valid ? 'success' : 'failed',
    ...(valid ? {} : { ERROR: 'invalid_or_expired_token' }),
  });

  if (!valid) process.exit(1);
}
