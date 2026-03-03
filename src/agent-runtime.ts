import { AgentRuntime, ContainerConfig } from './types.js';

const SUPPORTED_AGENT_RUNTIMES: AgentRuntime[] = [
  'claude',
  'codex',
  'gemini',
  'opencode',
];

export function isAgentRuntime(value: string): value is AgentRuntime {
  return SUPPORTED_AGENT_RUNTIMES.includes(value as AgentRuntime);
}

export function resolveAgentRuntime(config?: ContainerConfig): AgentRuntime {
  const raw = config?.runtime?.toLowerCase();
  if (!raw) return 'claude';
  if (isAgentRuntime(raw)) return raw;
  return 'claude';
}

export function getAgentRuntimeSecrets(runtime: AgentRuntime): string[] {
  switch (runtime) {
    case 'claude':
      return [
        'CLAUDE_CODE_OAUTH_TOKEN',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_AUTH_TOKEN',
      ];
    case 'codex':
      return [
        'OPENAI_API_KEY',
        'OPENAI_BASE_URL',
        'OPENAI_ORG_ID',
        'OPENAI_PROJECT',
      ];
    case 'gemini':
      return [
        'GEMINI_API_KEY',
        'GOOGLE_API_KEY',
        'GOOGLE_GENAI_API_KEY',
        'GOOGLE_CLOUD_PROJECT',
        'GOOGLE_CLOUD_LOCATION',
        'VERTEX_PROJECT',
        'VERTEX_LOCATION',
      ];
    case 'opencode':
      return [
        // OpenCode can proxy to multiple providers; pass common auth envs.
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_AUTH_TOKEN',
        'OPENAI_API_KEY',
        'OPENAI_BASE_URL',
        'OPENAI_ORG_ID',
        'OPENAI_PROJECT',
        'GEMINI_API_KEY',
        'GOOGLE_API_KEY',
        'GOOGLE_GENAI_API_KEY',
        'GOOGLE_CLOUD_PROJECT',
        'GOOGLE_CLOUD_LOCATION',
        'VERTEX_PROJECT',
        'VERTEX_LOCATION',
      ];
    default:
      return [];
  }
}
