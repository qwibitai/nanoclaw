import { readEnvFile } from './env.js';

export type AgentBackend = 'claude' | 'openai';
export type CredentialAuthMode = 'api-key' | 'oauth';

export interface AgentBackendConfig {
  backend: AgentBackend;
  model?: string;
  upstreamBaseUrl: string;
  containerBaseUrlEnvVar: 'ANTHROPIC_BASE_URL' | 'OPENAI_BASE_URL';
  containerCredentialEnvVar:
    | 'ANTHROPIC_API_KEY'
    | 'CLAUDE_CODE_OAUTH_TOKEN'
    | 'OPENAI_API_KEY';
  authMode: CredentialAuthMode;
}

export function getAgentBackendConfig(): AgentBackendConfig {
  const env = readEnvFile([
    'AGENT_BACKEND',
    'AGENT_MODEL',
    'OPENAI_MODEL',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
  ]);

  const requestedBackend = (
    process.env.AGENT_BACKEND ||
    env.AGENT_BACKEND ||
    'claude'
  ).toLowerCase();

  if (requestedBackend === 'openai') {
    return {
      backend: 'openai',
      model: process.env.AGENT_MODEL || env.AGENT_MODEL || env.OPENAI_MODEL,
      upstreamBaseUrl:
        process.env.OPENAI_BASE_URL ||
        env.OPENAI_BASE_URL ||
        'https://api.openai.com/v1',
      containerBaseUrlEnvVar: 'OPENAI_BASE_URL',
      containerCredentialEnvVar: 'OPENAI_API_KEY',
      authMode: 'api-key',
    };
  }

  if (requestedBackend !== 'claude') {
    throw new Error(
      `Unsupported AGENT_BACKEND "${requestedBackend}". Expected "claude" or "openai".`,
    );
  }

  return {
    backend: 'claude',
    upstreamBaseUrl:
      process.env.ANTHROPIC_BASE_URL ||
      env.ANTHROPIC_BASE_URL ||
      'https://api.anthropic.com',
    containerBaseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    containerCredentialEnvVar:
      process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY
        ? 'ANTHROPIC_API_KEY'
        : 'CLAUDE_CODE_OAUTH_TOKEN',
    authMode:
      process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY
        ? 'api-key'
        : 'oauth',
  };
}
