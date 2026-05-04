/**
 * Environment loader for the rial integration.
 *
 * Reads from process.env (the systemd unit / docker compose passes vars
 * straight through; the existing readEnvFile() is for runtime-injected
 * config like ASSISTANT_NAME, not secrets). All values are read lazily
 * so tests can override them.
 *
 * Default behaviour: integration disabled. The flag must be explicitly
 * set to the literal string 'true' to enable anything in this module.
 */

import { logger } from '../logger.js';

export interface RialConfig {
  apiBaseUrl: string;
  hmacSecret: string;
  notifyQueueUrl: string;
  awsRegion: string;
  userAgent: string;
}

const DEFAULT_USER_AGENT = 'rialclaw/0.1';

export function isRialEnabled(): boolean {
  return process.env.RIAL_INTEGRATION_ENABLED === 'true';
}

/**
 * Returns config if all required values are present, otherwise null
 * and logs which keys are missing. Never throws — callers gate on the
 * return value and skip work if config is incomplete.
 */
export function loadRialConfig(): RialConfig | null {
  const apiBaseUrl = (process.env.RIAL_API_BASE_URL || '').trim();
  const hmacSecret = (process.env.RIAL_BOT_HMAC_SECRET || '').trim();
  const notifyQueueUrl = (process.env.RIAL_WA_NOTIFY_QUEUE_URL || '').trim();
  const awsRegion = (process.env.AWS_REGION || 'us-east-1').trim();
  const userAgent = (
    process.env.RIAL_BOT_USER_AGENT || DEFAULT_USER_AGENT
  ).trim();

  const missing: string[] = [];
  if (!apiBaseUrl) missing.push('RIAL_API_BASE_URL');
  if (!hmacSecret) missing.push('RIAL_BOT_HMAC_SECRET');
  // notifyQueueUrl is only needed for the SQS poller; commands work without it.

  if (missing.length > 0) {
    logger.warn(
      { missing },
      'rial: integration enabled but required env vars missing — skipping',
    );
    return null;
  }

  return {
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''),
    hmacSecret,
    notifyQueueUrl,
    awsRegion,
    userAgent,
  };
}
