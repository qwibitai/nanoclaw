import type { AddressInfo } from 'net';

import {
  detectAuthMode,
  startCredentialProxy,
} from '../src/credential-proxy.js';
import { readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

type ProbeOutcome = {
  ok: boolean;
  statusCode?: number;
  error?: string;
  tempApiKey?: string;
};

export type CredentialCheckResult = {
  authMode: 'api-key' | 'oauth';
  upstream: string;
  model: string;
  authProbe: 'ok' | 'failed' | 'missing';
  authHttpStatus: number;
  modelProbe: 'ok' | 'failed' | 'skipped';
  modelHttpStatus: number;
  status: 'success' | 'failed';
  error: string;
};

const DEFAULT_TIMEOUT_MS = 15000;

function trimErrorMessage(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

async function readResponseError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `HTTP ${response.status}`;

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.error === 'string') {
      return trimErrorMessage(parsed.error);
    }
    if (
      parsed.error &&
      typeof parsed.error === 'object' &&
      !Array.isArray(parsed.error)
    ) {
      const message = (parsed.error as Record<string, unknown>).message;
      if (typeof message === 'string') return trimErrorMessage(message);
    }
    if (typeof parsed.message === 'string') {
      return trimErrorMessage(parsed.message);
    }
  } catch {
    // Fall through to raw text.
  }

  return trimErrorMessage(text);
}

export function extractTemporaryApiKey(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const directKeys = ['api_key', 'apiKey', 'temporary_api_key', 'temp_api_key'];
  for (const key of directKeys) {
    if (typeof record[key] === 'string' && record[key]) {
      return record[key] as string;
    }
  }

  for (const value of Object.values(record)) {
    const nested = extractTemporaryApiKey(value);
    if (nested) return nested;
  }

  return null;
}

export async function checkCredentials(): Promise<CredentialCheckResult> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
  ]);

  const upstream = secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const authMode = detectAuthMode();
  const configuredModel = secrets.ANTHROPIC_MODEL || '';

  const hasCredential =
    authMode === 'api-key'
      ? Boolean(secrets.ANTHROPIC_API_KEY)
      : Boolean(secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN);

  if (!hasCredential) {
    return {
      authMode,
      upstream,
      model: configuredModel || 'none',
      authProbe: 'missing',
      authHttpStatus: 0,
      modelProbe: 'skipped',
      modelHttpStatus: 0,
      status: 'failed',
      error: 'no_configured_credentials',
    };
  }

  logger.info({ authMode, upstream, configuredModel }, 'Starting credential sanity check');

  const server = await startCredentialProxy(0);
  const proxyPort = (server.address() as AddressInfo).port;
  const proxyBaseUrl = `http://127.0.0.1:${proxyPort}`;

  let authProbe: ProbeOutcome = { ok: false, error: 'not_run' };
  let modelProbe: ProbeOutcome = { ok: true };
  let modelProbeStatus: CredentialCheckResult['modelProbe'] = 'skipped';

  try {
    authProbe =
      authMode === 'api-key'
        ? await probeApiKeyAuth(proxyBaseUrl)
        : await probeOAuthAuth(proxyBaseUrl);

    if (authProbe.ok && configuredModel) {
      modelProbe = await probeConfiguredModel(
        proxyBaseUrl,
        authMode,
        configuredModel,
        authProbe.tempApiKey,
      );
      modelProbeStatus = modelProbe.ok ? 'ok' : 'failed';
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    authProbe = { ok: false, error: trimErrorMessage(message) };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const status =
    authProbe.ok && (modelProbeStatus === 'skipped' || modelProbe.ok)
      ? 'success'
      : 'failed';

  return {
    authMode,
    upstream,
    model: configuredModel || 'none',
    authProbe: authProbe.ok ? 'ok' : 'failed',
    authHttpStatus: authProbe.statusCode ?? 0,
    modelProbe: modelProbeStatus,
    modelHttpStatus: modelProbe.statusCode ?? 0,
    status,
    error: authProbe.ok ? modelProbe.error || '' : authProbe.error || '',
  };
}

async function probeApiKeyAuth(proxyBaseUrl: string): Promise<ProbeOutcome> {
  const response = await fetch(`${proxyBaseUrl}/v1/models`, {
    headers: { 'x-api-key': 'placeholder' },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      error: await readResponseError(response),
    };
  }

  return { ok: true, statusCode: response.status };
}

async function probeOAuthAuth(proxyBaseUrl: string): Promise<ProbeOutcome> {
  const response = await fetch(
    `${proxyBaseUrl}/api/oauth/claude_cli/create_api_key`,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer placeholder',
        'content-type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      error: await readResponseError(response),
    };
  }

  let tempApiKey: string | null = null;
  try {
    tempApiKey = extractTemporaryApiKey(await response.json());
  } catch {
    tempApiKey = null;
  }

  return {
    ok: true,
    statusCode: response.status,
    tempApiKey: tempApiKey || undefined,
  };
}

async function probeConfiguredModel(
  proxyBaseUrl: string,
  authMode: 'api-key' | 'oauth',
  model: string,
  tempApiKey?: string,
): Promise<ProbeOutcome> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (authMode === 'api-key') {
    headers['x-api-key'] = 'placeholder';
  } else if (tempApiKey) {
    headers['x-api-key'] = tempApiKey;
  } else {
    return {
      ok: false,
      error: 'OAuth exchange succeeded but did not return a temporary API key',
    };
  }

  const response = await fetch(`${proxyBaseUrl}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      error: await readResponseError(response),
    };
  }

  return { ok: true, statusCode: response.status };
}

export async function run(_args: string[]): Promise<void> {
  const result = await checkCredentials();

  emitStatus('CHECK_CREDENTIALS', {
    AUTH_MODE: result.authMode,
    UPSTREAM: result.upstream,
    MODEL: result.model,
    AUTH_PROBE: result.authProbe,
    AUTH_HTTP_STATUS: result.authHttpStatus,
    MODEL_PROBE: result.modelProbe,
    MODEL_HTTP_STATUS: result.modelHttpStatus,
    STATUS: result.status,
    ERROR: result.error,
    LOG: 'logs/setup.log',
  });

  if (result.status === 'failed') {
    process.exit(1);
  }
}