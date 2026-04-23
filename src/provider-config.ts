import fs from 'fs';
import os from 'os';
import path from 'path';

import YAML from 'yaml';

import { readEnvFile } from './env.js';

export type LlmProvider = 'anthropic' | 'openai' | 'google' | 'codex';

export interface ProviderConfig {
  name: string;
  provider: LlmProvider;
  model: string;
  usesCredentialProxy: boolean;
  allowDirectSecretInjection: boolean;
  apiKey?: string;
  upstreamBaseURL?: string;
  codexOAuthJson?: string;
}

export interface ResolvedProviderConfig {
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
  fallbackProviders: string[];
  allowDirectSecretInjection: boolean;
  source: 'yaml' | 'env';
}

export interface ContainerProviderConfig {
  provider: LlmProvider;
  model: string;
  apiKey?: string;
  baseURL?: string;
  codexOAuthJson?: string;
}

export interface ContainerProviderEnvConfig {
  providers: Record<string, ContainerProviderConfig>;
  defaultProvider: string;
  fallbackProviders: string[];
}

const PROVIDER_PRIORITY: LlmProvider[] = [
  'anthropic',
  'openai',
  'google',
  'codex',
];

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'CODEX_MODEL',
  'OAS_CODEX_OAUTH_JSON',
  'OAS_CODEX_AUTH_PATH',
  'ALLOW_DIRECT_SECRET_INJECTION',
] as const;

const DEFAULT_UPSTREAM_BASE_URL: Record<'anthropic' | 'openai', string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

const DEFAULT_MODEL_BY_PROVIDER: Record<LlmProvider, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4.1-mini',
  google: 'gemini-2.5-flash',
  codex: 'gpt-5.4',
};

function requiredValue(
  value: string | undefined,
  name: string,
  provider: LlmProvider,
): string {
  if (value) return value;
  throw new Error(
    `[provider-config] ${provider} provider requires ${name}, but it was not found in configuration.`,
  );
}

function isDirectSecretInjectionEnabled(value: string | undefined): boolean {
  return value === 'true';
}

function resolveCodexAuthPath(envPath: string | undefined): string {
  if (envPath) {
    return envPath.startsWith('~')
      ? path.join(os.homedir(), envPath.slice(1))
      : envPath;
  }
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'auth.json');
}

function readCodexAuthFile(authPath: string): string | undefined {
  try {
    const content = fs.readFileSync(authPath, 'utf-8');
    JSON.parse(content);
    return content;
  } catch {
    return undefined;
  }
}

function requireDirectSecretInjectionOptIn(
  provider: 'google' | 'codex',
  enabled: boolean,
): void {
  if (enabled) return;
  throw new Error(
    `[provider-config] ${provider} provider requires direct secret injection, but ALLOW_DIRECT_SECRET_INJECTION=true is not set.\n` +
      'Direct secret injection exposes provider credentials to the container process.\n' +
      'Set ALLOW_DIRECT_SECRET_INJECTION=true only if you accept this risk.',
  );
}

function loadEnvConfig(): Record<string, string> {
  return {
    ...readEnvFile([...ENV_KEYS]),
    ...Object.fromEntries(
      [...ENV_KEYS]
        .map((key) => [key, process.env[key]])
        .filter((entry): entry is [string, string] => !!entry[1]),
    ),
  };
}

function resolveProviderFromEnv(
  name: string,
  provider: LlmProvider,
  env: Record<string, string>,
  allowDirectSecretInjection: boolean,
  modelOverride?: string,
): ProviderConfig | undefined {
  if (provider === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) return undefined;
    return {
      name,
      provider,
      model: modelOverride || env.ANTHROPIC_MODEL || DEFAULT_MODEL_BY_PROVIDER.anthropic,
      usesCredentialProxy: true,
      allowDirectSecretInjection: false,
      apiKey: requiredValue(env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY', provider),
      upstreamBaseURL:
        env.ANTHROPIC_BASE_URL || DEFAULT_UPSTREAM_BASE_URL.anthropic,
    };
  }

  if (provider === 'openai') {
    if (!env.OPENAI_API_KEY) return undefined;
    return {
      name,
      provider,
      model: modelOverride || env.OPENAI_MODEL || DEFAULT_MODEL_BY_PROVIDER.openai,
      usesCredentialProxy: true,
      allowDirectSecretInjection: false,
      apiKey: requiredValue(env.OPENAI_API_KEY, 'OPENAI_API_KEY', provider),
      upstreamBaseURL: env.OPENAI_BASE_URL || DEFAULT_UPSTREAM_BASE_URL.openai,
    };
  }

  if (provider === 'google') {
    if (!env.GEMINI_API_KEY) return undefined;
    requireDirectSecretInjectionOptIn(provider, allowDirectSecretInjection);
    return {
      name,
      provider,
      model: modelOverride || env.GEMINI_MODEL || DEFAULT_MODEL_BY_PROVIDER.google,
      usesCredentialProxy: false,
      allowDirectSecretInjection,
      apiKey: requiredValue(env.GEMINI_API_KEY, 'GEMINI_API_KEY', provider),
    };
  }

  const codexAuthPath = resolveCodexAuthPath(env.OAS_CODEX_AUTH_PATH);
  const codexOAuthJson =
    env.OAS_CODEX_OAUTH_JSON || readCodexAuthFile(codexAuthPath);
  if (!codexOAuthJson) return undefined;
  requireDirectSecretInjectionOptIn(provider, allowDirectSecretInjection);
  return {
    name,
    provider,
    model: modelOverride || env.CODEX_MODEL || DEFAULT_MODEL_BY_PROVIDER.codex,
    usesCredentialProxy: false,
    allowDirectSecretInjection,
    codexOAuthJson,
  };
}

function readNanoclawYaml():
  | {
      providers: Record<
        string,
        {
          provider: string;
          model: string;
        }
      >;
      defaultProvider?: string;
      fallbacks?: string[];
    }
  | undefined {
  const configPath = path.join(process.cwd(), 'nanoclaw.yaml');
  if (!fs.existsSync(configPath)) return undefined;

  const parsed = YAML.parse(fs.readFileSync(configPath, 'utf-8')) as
    | Record<string, unknown>
    | null
    | undefined;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[provider-config] nanoclaw.yaml must contain a mapping.');
  }

  const providersRaw = parsed.providers;
  if (!providersRaw || typeof providersRaw !== 'object' || Array.isArray(providersRaw)) {
    throw new Error('[provider-config] nanoclaw.yaml requires a providers mapping.');
  }

  const providers: Record<
    string,
    {
      provider: string;
      model: string;
    }
  > = {};
  for (const [name, value] of Object.entries(providersRaw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`[provider-config] providers.${name} must be a mapping.`);
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.provider !== 'string' || typeof entry.model !== 'string') {
      throw new Error(
        `[provider-config] providers.${name} requires string provider and model fields.`,
      );
    }
    providers[name] = { provider: entry.provider, model: entry.model };
  }

  const defaultProvider =
    typeof parsed.defaultProvider === 'string' ? parsed.defaultProvider : undefined;
  const fallbacks = Array.isArray(parsed.fallbacks)
    ? parsed.fallbacks.map((value) => {
        if (typeof value !== 'string') {
          throw new Error('[provider-config] fallbacks must be a string array.');
        }
        return value;
      })
    : undefined;

  return { providers, defaultProvider, fallbacks };
}

function normalizeYamlProvider(provider: string): LlmProvider {
  if (provider === 'anthropic' || provider === 'openai' || provider === 'codex') {
    return provider;
  }
  if (provider === 'google' || provider === 'gemini') {
    return 'google';
  }
  throw new Error(
    `[provider-config] Unsupported provider "${provider}" in nanoclaw.yaml.`,
  );
}

function resolveYamlProviderConfig(
  env: Record<string, string>,
): ResolvedProviderConfig | undefined {
  const yamlConfig = readNanoclawYaml();
  if (!yamlConfig) return undefined;

  const allowDirectSecretInjection = isDirectSecretInjectionEnabled(
    env.ALLOW_DIRECT_SECRET_INJECTION,
  );

  const providers: Record<string, ProviderConfig> = {};
  for (const [name, entry] of Object.entries(yamlConfig.providers)) {
    const provider = normalizeYamlProvider(entry.provider);
    const resolved = resolveProviderFromEnv(
      name,
      provider,
      env,
      allowDirectSecretInjection,
      entry.model,
    );
    if (!resolved) {
      throw new Error(
        `[provider-config] providers.${name} requires credentials for ${provider}, but none were found.`,
      );
    }
    providers[name] = resolved;
  }

  const configuredNames = Object.keys(providers);
  if (configuredNames.length === 0) {
    throw new Error('[provider-config] nanoclaw.yaml must define at least one provider.');
  }

  const defaultProvider = yamlConfig.defaultProvider || configuredNames[0];
  if (!providers[defaultProvider]) {
    throw new Error(
      `[provider-config] defaultProvider "${defaultProvider}" does not exist in providers.`,
    );
  }

  const fallbackProviders = (yamlConfig.fallbacks || []).map((name) => {
    if (!providers[name]) {
      throw new Error(
        `[provider-config] fallback provider "${name}" does not exist in providers.`,
      );
    }
    return name;
  });

  return {
    providers,
    defaultProvider,
    fallbackProviders,
    allowDirectSecretInjection,
    source: 'yaml',
  };
}

function resolveLegacyProviderConfig(
  env: Record<string, string>,
): ResolvedProviderConfig {
  const allowDirectSecretInjection = isDirectSecretInjectionEnabled(
    env.ALLOW_DIRECT_SECRET_INJECTION,
  );

  for (const provider of PROVIDER_PRIORITY) {
    const resolved = resolveProviderFromEnv(
      'default',
      provider,
      env,
      allowDirectSecretInjection,
    );
    if (!resolved) continue;
    return {
      providers: { default: resolved },
      defaultProvider: 'default',
      fallbackProviders: [],
      allowDirectSecretInjection,
      source: 'env',
    };
  }

  throw new Error(
    '[provider-config] No supported provider credentials found.\n' +
      'Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OAS_CODEX_AUTH_PATH\n' +
      '(Or have ~/.codex/auth.json from `codex login`)\n' +
      '\n' +
      'NOTE: OAuth-based authentication (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN) is not supported.\n' +
      'Anthropic prohibits third-party use of OAuth tokens. Use an API key from https://console.anthropic.com instead.',
  );
}

export function resolveProviderConfig(): ResolvedProviderConfig {
  const env = loadEnvConfig();
  return resolveYamlProviderConfig(env) || resolveLegacyProviderConfig(env);
}

export function resolveProviderExecutionConfig(
  resolvedConfig: ResolvedProviderConfig,
  selectedProvider?: string,
): {
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
  fallbackProviders: string[];
} {
  const configuredOrder = [
    resolvedConfig.defaultProvider,
    ...resolvedConfig.fallbackProviders,
  ].filter((name, index, arr) => arr.indexOf(name) === index);

  const preferred =
    selectedProvider && resolvedConfig.providers[selectedProvider]
      ? selectedProvider
      : resolvedConfig.defaultProvider;

  const ordered = [
    preferred,
    ...configuredOrder.filter((name) => name !== preferred),
  ];

  return {
    providers: resolvedConfig.providers,
    defaultProvider: preferred,
    fallbackProviders: ordered.slice(1),
  };
}

export function buildContainerProviderEnv(
  resolvedConfig: ResolvedProviderConfig,
  selectedProvider: string | undefined,
  containerHostGateway: string,
  credentialProxyPort: number,
): Record<string, string> {
  const execution = resolveProviderExecutionConfig(
    resolvedConfig,
    selectedProvider,
  );

  const proxyBaseUrl = `http://${containerHostGateway}:${credentialProxyPort}`;
  const providers: Record<string, ContainerProviderConfig> = {};

  for (const [name, config] of Object.entries(execution.providers)) {
    if (config.provider === 'anthropic' || config.provider === 'openai') {
      providers[name] = {
        provider: config.provider,
        model: config.model,
        apiKey: `placeholder-${name}`,
        baseURL: `${proxyBaseUrl}/__provider/${encodeURIComponent(name)}`,
      };
      continue;
    }

    if (config.provider === 'google') {
      providers[name] = {
        provider: config.provider,
        model: config.model,
        apiKey: requiredValue(config.apiKey, 'GEMINI_API_KEY', config.provider),
      };
      continue;
    }

    providers[name] = {
      provider: config.provider,
      model: config.model,
      codexOAuthJson: requiredValue(
        config.codexOAuthJson,
        'OAS_CODEX_OAUTH_JSON',
        config.provider,
      ),
    };
  }

  const envConfig: ContainerProviderEnvConfig = {
    providers,
    defaultProvider: execution.defaultProvider,
    fallbackProviders: execution.fallbackProviders,
  };

  return {
    NANOCLAW_PROVIDER_CONFIG_JSON: JSON.stringify(envConfig),
  };
}
