import { z } from 'zod';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/**
 * Zod schema for all recognized NanoClaw environment variables.
 * Optional vars use .optional() so missing values don't cause errors.
 * Coerce is used for numeric vars that arrive as strings from .env.
 */
const envSchema = z.object({
  // === Required ===
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),

  // === Identity ===
  ASSISTANT_NAME: z.string().optional(),
  ASSISTANT_HAS_OWN_NUMBER: z.enum(['true', 'false']).optional(),

  // === AI Model ===
  CLAUDE_MODEL: z.string().optional(),

  // === Cost Control ===
  DAILY_API_LIMIT_USD: z.coerce
    .number()
    .positive('DAILY_API_LIMIT_USD must be positive')
    .optional(),

  // === Container Settings ===
  CONTAINER_PREFIX: z.string().optional(),
  CONTAINER_IMAGE: z.string().optional(),
  CONTAINER_TIMEOUT: z.coerce
    .number()
    .int()
    .positive('CONTAINER_TIMEOUT must be positive')
    .optional(),
  CONTAINER_MAX_OUTPUT_SIZE: z.coerce
    .number()
    .int()
    .positive('CONTAINER_MAX_OUTPUT_SIZE must be positive')
    .optional(),
  IDLE_TIMEOUT: z.coerce
    .number()
    .int()
    .positive('IDLE_TIMEOUT must be positive')
    .optional(),
  MAX_CONCURRENT_CONTAINERS: z.coerce
    .number()
    .int()
    .min(1, 'MAX_CONCURRENT_CONTAINERS must be at least 1')
    .max(20, 'MAX_CONCURRENT_CONTAINERS must be at most 20')
    .optional(),

  // === Network ===
  CREDENTIAL_PROXY_PORT: z.coerce
    .number()
    .int()
    .min(1024, 'CREDENTIAL_PROXY_PORT must be >= 1024')
    .max(65535, 'CREDENTIAL_PROXY_PORT must be <= 65535')
    .optional(),
  CREDENTIAL_PROXY_HOST: z.string().optional(),

  // === Polling Intervals ===
  POLL_INTERVAL: z.coerce
    .number()
    .int()
    .positive('POLL_INTERVAL must be positive')
    .optional(),
  SCHEDULER_POLL_INTERVAL: z.coerce
    .number()
    .int()
    .positive('SCHEDULER_POLL_INTERVAL must be positive')
    .optional(),
  IPC_POLL_INTERVAL: z.coerce
    .number()
    .int()
    .positive('IPC_POLL_INTERVAL must be positive')
    .optional(),

  // === Google Chat ===
  GOOGLE_CHAT_ENABLED: z.enum(['true', 'false']).optional(),
  GOOGLE_CHAT_AGENT_NAME: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  GOOGLE_CHAT_BOT_SA: z.string().optional(),

  // === Gmail ===
  GMAIL_WEBHOOK_ENABLED: z.enum(['true', 'false']).optional(),
  GMAIL_MCP_DIR: z.string().optional(),
  GMAIL_DIRECT_SEND_ALLOWLIST: z.string().optional(),
  GMAIL_NOTIFY_EMAIL: z.string().optional(),
  GMAIL_CC_EMAIL: z.string().optional(),

  // === Remote Control ===
  REMOTE_CONTROL_PIN: z
    .string()
    .min(4, 'REMOTE_CONTROL_PIN must be at least 4 characters')
    .optional(),

  // === Voice Transcription ===
  WHISPER_BIN: z.string().optional(),
  WHISPER_MODEL: z.string().optional(),

  // === Logging ===
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .optional(),

  // === Timezone ===
  TZ: z.string().optional(),
});

/**
 * Read all known env var names from .env file (non-secret vars only).
 * Secrets like ANTHROPIC_API_KEY are read from process.env, never from
 * readEnvFile (which is designed for non-secret config).
 */
function collectEnv(): Record<string, string | undefined> {
  const allKeys = Object.keys(envSchema.shape);
  const fileVars = readEnvFile(allKeys);

  // Merge: process.env takes precedence over .env file values
  const merged: Record<string, string | undefined> = {};
  for (const key of allKeys) {
    merged[key] = process.env[key] || fileVars[key] || undefined;
  }
  return merged;
}

/**
 * Validate environment variables at startup.
 * Warns on invalid optional vars. Exits if ANTHROPIC_API_KEY is missing.
 */
export function validateEnv(): void {
  const env = collectEnv();

  const result = envSchema.safeParse(env);

  if (result.success) {
    const configuredCount = Object.values(env).filter(Boolean).length;
    logger.info(
      { configured: configuredCount },
      `Environment validated: ${configuredCount} vars configured`,
    );
    return;
  }

  const issues = result.error.issues;

  // Check if ANTHROPIC_API_KEY is among the failures
  const apiKeyMissing = issues.some((i) => i.path[0] === 'ANTHROPIC_API_KEY');

  // Log each issue as a warning
  for (const issue of issues) {
    const varName = String(issue.path[0] || 'unknown');
    logger.warn(
      { var: varName, message: issue.message },
      `Env validation: ${varName} — ${issue.message}`,
    );
  }

  if (apiKeyMissing) {
    logger.fatal(
      'ANTHROPIC_API_KEY is not set. Set it in .env or as an environment variable.',
    );
    process.exit(1);
  }

  // Non-fatal: continue with warnings
  const configuredCount = Object.values(env).filter(Boolean).length;
  logger.warn(
    { configured: configuredCount, issues: issues.length },
    `Environment validated with ${issues.length} warning(s): ${configuredCount} vars configured`,
  );
}
