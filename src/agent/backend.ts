import {
  AGENT_BACKEND_TYPES,
  type AgentBackendOptions,
  type AgentBackendType,
} from '../api/options.js';

export const DEFAULT_AGENT_BACKEND_OPTIONS: AgentBackendOptions = {
  type: 'claudeCode',
};

export { AGENT_BACKEND_TYPES };
export type { AgentBackendOptions, AgentBackendType };

export function isAgentBackendType(value: unknown): value is AgentBackendType {
  return AGENT_BACKEND_TYPES.some((backendType) => backendType === value);
}

export function normalizeAgentBackendOptions(
  value: unknown,
): AgentBackendOptions {
  if (value === undefined || value === null) {
    return { ...DEFAULT_AGENT_BACKEND_OPTIONS };
  }

  if (
    value &&
    typeof value === 'object' &&
    'type' in value &&
    isAgentBackendType(value.type)
  ) {
    return { type: value.type };
  }

  throw new Error(
    `Invalid agent backend "${String(value)}"; expected { type: ${AGENT_BACKEND_TYPES.join(' | ')} }`,
  );
}
