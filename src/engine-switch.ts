export type Engine = 'claude' | 'codex';

export type ProviderFailureClass =
  | 'retryable'
  | 'quota'
  | 'rate_limit'
  | 'transport'
  | 'auth'
  | 'config'
  | 'unknown';

const QUOTA_PATTERNS = [
  'rate_limit_event',
  'rate limit',
  'rate_limit',
  'hit your limit',
  'insufficient_quota',
  'quota exceeded',
  'quota',
  'billing',
  '429',
];

const AUTH_PATTERNS = [
  '401',
  'unauthorized',
  'forbidden',
  'failed to authenticate',
  'invalid api key',
  'oauth token has expired',
  'authentication',
  'oauth',
];

const TRANSPORT_PATTERNS = [
  'econnreset',
  'econnrefused',
  'etimedout',
  'enotfound',
  'eai_again',
  'socket hang up',
  'fetch failed',
  'network',
  'connection refused',
];

const CONFIG_PATTERNS = [
  'invalid model',
  'model not found',
  'not configured',
  'missing',
  'unsupported',
  'bad request',
  'base url',
  'api key',
];

function matchesAny(reason: string, patterns: string[]): boolean {
  const normalized = reason.toLowerCase();
  return patterns.some((pattern) => normalized.includes(pattern));
}

export function classifyProviderFailure(reason: string): ProviderFailureClass {
  if (matchesAny(reason, QUOTA_PATTERNS)) return 'quota';
  if (matchesAny(reason, AUTH_PATTERNS)) return 'auth';
  if (matchesAny(reason, CONFIG_PATTERNS)) return 'config';
  if (matchesAny(reason, TRANSPORT_PATTERNS)) return 'transport';
  return 'retryable';
}

export function shouldFailover(
  failureClass?: ProviderFailureClass | string,
): boolean {
  return (
    failureClass === 'quota' ||
    failureClass === 'rate_limit' ||
    failureClass === 'transport' ||
    failureClass === 'auth'
  );
}

export function getEngineOrder(preferred: Engine): Engine[] {
  return preferred === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];
}
