import { isVaultConfigured, readEnvFile, refreshSecrets } from './env.js';

export type AuthMode = 'api-key' | 'oauth';

export const CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const;

export interface CredentialState {
  authMode: AuthMode;
  apiKey?: string;
  oauthToken?: string;
  baseUrl: string;
  credentialSource: 'vault-backed' | 'env-file';
}

type HeaderValue = string | number | string[] | undefined;

function buildCredentialState(
  secrets: Record<string, string>,
): CredentialState {
  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';

  return {
    authMode,
    apiKey: secrets.ANTHROPIC_API_KEY,
    oauthToken: secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN,
    baseUrl: secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    credentialSource: isVaultConfigured() ? 'vault-backed' : 'env-file',
  };
}

export async function loadCredentialState(): Promise<CredentialState> {
  if (isVaultConfigured()) {
    await refreshSecrets([...CREDENTIAL_KEYS]);
  }

  return loadCredentialStateSync();
}

export function loadCredentialStateSync(): CredentialState {
  const secrets = readEnvFile([...CREDENTIAL_KEYS]);
  return buildCredentialState(secrets);
}

export function buildProxySessionEnv(
  proxyBaseUrl: string,
): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: proxyBaseUrl,
  };
  const credentialState = loadCredentialStateSync();

  if (credentialState.authMode === 'api-key') {
    env.ANTHROPIC_API_KEY = 'placeholder';
  } else {
    env.CLAUDE_CODE_OAUTH_TOKEN = 'placeholder';
  }

  return env;
}

export function applyCredentialHeaders(
  reqHeaders: Record<string, HeaderValue>,
  credentialState: CredentialState,
): Record<string, HeaderValue> {
  const headers = { ...reqHeaders };

  if (credentialState.authMode === 'api-key') {
    delete headers['x-api-key'];
    headers['x-api-key'] = credentialState.apiKey;
    return headers;
  }

  if (headers.authorization) {
    delete headers.authorization;
    if (credentialState.oauthToken) {
      headers.authorization = `Bearer ${credentialState.oauthToken}`;
    }
  }

  return headers;
}
