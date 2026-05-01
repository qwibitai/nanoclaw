import { getAllAgentGroups } from './db/agent-groups.js';

const ONECLI_AGENT_IDENTIFIER_PATTERN = /^[a-z0-9-]+$/;

export function toOneCliAgentIdentifier(agentGroupId: string): string {
  const identifier = agentGroupId.replace(/_/g, '-');

  if (!ONECLI_AGENT_IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`Agent group ID "${agentGroupId}" produces an invalid OneCLI identifier: "${identifier}"`);
  }

  return identifier;
}

export function resolveAgentGroupByOneCliIdentifier(identifier: string) {
  const matches = getAllAgentGroups().filter((agentGroup) => toOneCliAgentIdentifier(agentGroup.id) === identifier);
  return matches.length === 1 ? matches[0] : undefined;
}
