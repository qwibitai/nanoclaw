import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const TRACE_CONFIG_KEYS = [
  'PROMPT_TRACE_ENABLED',
  'PROMPT_TRACE_REDACT',
  'PROMPT_TRACE_MAX_CHARS',
  'PROMPT_TRACE_DIR',
  'PROMPT_TRACE_INCLUDE_INTERNAL',
];

const SECRET_ENV_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'OPENAI_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'CURSOR_API_KEY',
];

const CACHE_TTL_MS = 5_000;
const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_TRACE_DIR = path.resolve(process.cwd(), 'logs', 'prompt-trace');

export type PromptTraceDirection = 'external' | 'internal';

export interface PromptTraceEventInput {
  event: string;
  direction: PromptTraceDirection;
  groupFolder?: string;
  chatJid?: string;
  channel?: string;
  sessionId?: string;
  payload?: string | null;
  meta?: Record<string, unknown>;
}

interface PromptTraceSettings {
  enabled: boolean;
  redact: boolean;
  includeInternal: boolean;
  maxChars: number;
  traceDir: string;
  secrets: string[];
}

let cachedSettings: PromptTraceSettings | null = null;
let cachedAt = 0;

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value == null || value === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function readSettings(): PromptTraceSettings {
  const now = Date.now();
  if (cachedSettings && now - cachedAt < CACHE_TTL_MS) {
    return cachedSettings;
  }

  const fileEnv = readEnvFile([...TRACE_CONFIG_KEYS, ...SECRET_ENV_KEYS]);
  const envValue = (key: string): string | undefined =>
    process.env[key] ?? fileEnv[key];

  const secrets = unique(
    SECRET_ENV_KEYS
      .map((key) => envValue(key))
      .filter((value): value is string => !!value && value.length >= 4),
  ).sort((a, b) => b.length - a.length);

  cachedSettings = {
    enabled: parseBoolean(envValue('PROMPT_TRACE_ENABLED'), false),
    redact: parseBoolean(envValue('PROMPT_TRACE_REDACT'), true),
    includeInternal: parseBoolean(envValue('PROMPT_TRACE_INCLUDE_INTERNAL'), true),
    maxChars: parsePositiveInt(envValue('PROMPT_TRACE_MAX_CHARS'), DEFAULT_MAX_CHARS),
    traceDir: path.resolve(envValue('PROMPT_TRACE_DIR') || DEFAULT_TRACE_DIR),
    secrets,
  };
  cachedAt = now;
  return cachedSettings;
}

function redactPayload(payload: string, secrets: string[]): string {
  let out = payload;
  for (const secret of secrets) {
    out = out.split(secret).join('[REDACTED]');
  }
  out = out.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED_ANTHROPIC_KEY]');
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, '[REDACTED_GITHUB_TOKEN]');
  out = out.replace(/\b(?:xoxb|xoxp)-[A-Za-z0-9-]+\b/g, '[REDACTED_SLACK_TOKEN]');
  return out;
}

function normalizePayload(
  payload: string | null | undefined,
  settings: PromptTraceSettings,
): { payload?: string; payloadLength: number; truncated: boolean } {
  if (payload == null) {
    return { payloadLength: 0, truncated: false };
  }

  let processed = settings.redact
    ? redactPayload(payload, settings.secrets)
    : payload;
  const payloadLength = processed.length;

  let truncated = false;
  if (processed.length > settings.maxChars) {
    truncated = true;
    const omitted = processed.length - settings.maxChars;
    processed = `${processed.slice(0, settings.maxChars)}...[TRUNCATED ${omitted} chars]`;
  }

  return {
    payload: processed,
    payloadLength,
    truncated,
  };
}

export function inferChannelFromJid(jid: string | undefined): string | undefined {
  if (!jid) return undefined;
  if (jid.startsWith('tg:')) return 'telegram';
  if (jid.startsWith('dc:')) return 'discord';
  if (jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net')) return 'whatsapp';
  return undefined;
}

export function tracePromptEvent(input: PromptTraceEventInput): void {
  const settings = readSettings();
  if (!settings.enabled) return;
  if (input.direction === 'internal' && !settings.includeInternal) return;

  const ts = new Date().toISOString();
  const normalized = normalizePayload(input.payload, settings);
  const datePart = ts.slice(0, 10);
  const filePath = path.join(settings.traceDir, `${datePart}.jsonl`);

  const record: Record<string, unknown> = {
    ts,
    event: input.event,
    direction: input.direction,
    groupFolder: input.groupFolder,
    chatJid: input.chatJid,
    channel: input.channel,
    sessionId: input.sessionId,
    payloadLength: normalized.payloadLength,
    truncated: normalized.truncated,
    payload: normalized.payload,
    meta: input.meta,
  };

  for (const key of Object.keys(record)) {
    if (record[key] === undefined) {
      delete record[key];
    }
  }

  try {
    fs.mkdirSync(settings.traceDir, { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    logger.warn(
      { err, filePath },
      'Failed to write prompt trace event',
    );
  }
}

/** @internal - for tests only */
export function _resetPromptTraceCacheForTests(): void {
  cachedSettings = null;
  cachedAt = 0;
}
