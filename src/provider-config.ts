import { readEnvFile } from './env.js';

export type LlmProvider = 'anthropic' | 'openai' | 'gemini' | 'codex';

export interface ActiveProviderConfig {
  provider: LlmProvider;
  usesCredentialProxy: boolean;
  apiKey?: string;
  upstreamBaseURL?: string;
  codexOAuthJson?: string;
}

const PROVIDER_PRIORITY: LlmProvider[] = [
  'anthropic',
  'openai',
  'gemini',
  'codex',
];

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'GEMINI_API_KEY',
  'OAS_CODEX_OAUTH_JSON',
] as const;

const DEFAULT_UPSTREAM_BASE_URL: Record<'anthropic' | 'openai', string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

function requiredValue(
  value: string | undefined,
  name: string,
  provider: LlmProvider,
): string {
  if (value) return value;
  throw new Error(
    `[provider-config] ${provider} provider requires ${name}, but it was not found in .env`,
  );
}

/**
 * .env に設定されたキーから使用プロバイダーを自動検出します。
 * 優先順位: Anthropic > OpenAI > Gemini > Codex
 */
export function detectActiveProviderConfig(): ActiveProviderConfig {
  const env = readEnvFile([...ENV_KEYS]);

  for (const provider of PROVIDER_PRIORITY) {
    if (provider === 'anthropic' && env.ANTHROPIC_API_KEY) {
      return {
        provider,
        usesCredentialProxy: true,
        apiKey: requiredValue(env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY', provider),
        upstreamBaseURL:
          env.ANTHROPIC_BASE_URL || DEFAULT_UPSTREAM_BASE_URL.anthropic,
      };
    }

    if (provider === 'openai' && env.OPENAI_API_KEY) {
      return {
        provider,
        usesCredentialProxy: true,
        apiKey: requiredValue(env.OPENAI_API_KEY, 'OPENAI_API_KEY', provider),
        upstreamBaseURL: env.OPENAI_BASE_URL || DEFAULT_UPSTREAM_BASE_URL.openai,
      };
    }

    if (provider === 'gemini' && env.GEMINI_API_KEY) {
      return {
        provider,
        // Google provider は baseURL 上書き非対応のため、直接キー注入を使う。
        usesCredentialProxy: false,
        apiKey: requiredValue(env.GEMINI_API_KEY, 'GEMINI_API_KEY', provider),
      };
    }

    if (provider === 'codex' && env.OAS_CODEX_OAUTH_JSON) {
      return {
        provider,
        usesCredentialProxy: false,
        codexOAuthJson: requiredValue(
          env.OAS_CODEX_OAUTH_JSON,
          'OAS_CODEX_OAUTH_JSON',
          provider,
        ),
      };
    }
  }

  throw new Error(
    '[provider-config] No supported provider credentials found in .env. Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OAS_CODEX_OAUTH_JSON',
  );
}

/**
 * 検出済みプロバイダー設定から、コンテナ注入用の環境変数を生成します。
 */
export function buildContainerProviderEnv(
  providerConfig: ActiveProviderConfig,
  containerHostGateway: string,
  credentialProxyPort: number,
): Record<string, string> {
  const proxyBaseUrl = `http://${containerHostGateway}:${credentialProxyPort}`;

  if (providerConfig.provider === 'anthropic') {
    return {
      ANTHROPIC_BASE_URL: proxyBaseUrl,
      ANTHROPIC_API_KEY: 'placeholder',
    };
  }

  if (providerConfig.provider === 'openai') {
    return {
      OPENAI_BASE_URL: proxyBaseUrl,
      OPENAI_API_KEY: 'placeholder',
    };
  }

  if (providerConfig.provider === 'gemini') {
    return {
      GEMINI_API_KEY: requiredValue(
        providerConfig.apiKey,
        'GEMINI_API_KEY',
        providerConfig.provider,
      ),
    };
  }

  return {
    OAS_CODEX_OAUTH_JSON: requiredValue(
      providerConfig.codexOAuthJson,
      'OAS_CODEX_OAUTH_JSON',
      providerConfig.provider,
    ),
  };
}