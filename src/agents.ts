/**
 * Agents configuration loader for CamBot-Agent.
 * Parses agents.yaml, validates with Zod, and seeds DB tables.
 */
import fs from 'fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { AGENTS_CONFIG_PATH } from './config.js';
import {
  getAllAgentDefinitions,
  getProviderImage,
  setAgentDefinition,
  setProviderImage,
} from './db.js';
import { logger } from './logger.js';
import { WorkerDefinition } from './types.js';

export interface AgentOptions {
  containerImage: string;
  secretKeys: string[];
}

const AgentSchema = z.object({
  provider: z.string(),
  model: z.string(),
  personality: z.string().optional(),
  secrets: z.array(z.string()),
});

const AgentsConfigSchema = z.object({
  images: z.record(z.string(), z.string()),
  lead: z.string(),
  agents: z.record(z.string(), AgentSchema),
});

type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

let leadAgentId: string;

export function loadAgentsConfig(): void {
  const raw = fs.readFileSync(AGENTS_CONFIG_PATH, 'utf-8');
  const parsed = parseYaml(raw);
  const config: AgentsConfig = AgentsConfigSchema.parse(parsed);

  // Validate lead agent exists
  if (!config.agents[config.lead]) {
    throw new Error(
      `Lead agent "${config.lead}" not found in agents config`,
    );
  }

  // Validate all agent providers have images
  for (const [agentId, agent] of Object.entries(config.agents)) {
    if (!config.images[agent.provider]) {
      throw new Error(
        `Agent "${agentId}" references provider "${agent.provider}" with no image defined`,
      );
    }
  }

  // Seed provider_images table
  for (const [provider, image] of Object.entries(config.images)) {
    setProviderImage(provider, image);
    logger.debug({ provider, image }, 'Provider image registered');
  }

  // Seed agent_definitions table
  for (const [agentId, agent] of Object.entries(config.agents)) {
    const def: WorkerDefinition = {
      id: agentId,
      provider: agent.provider,
      model: agent.model,
      personality: agent.personality,
      secretKeys: agent.secrets,
    };
    setAgentDefinition(def);
    logger.debug({ agentId, provider: agent.provider }, 'Agent definition registered');
  }

  leadAgentId = config.lead;

  logger.info(
    {
      lead: config.lead,
      agentCount: Object.keys(config.agents).length,
      providerCount: Object.keys(config.images).length,
    },
    'Agents config loaded',
  );
}

export function getLeadAgentId(): string {
  return leadAgentId;
}

export function resolveAgentImage(agentId: string): AgentOptions {
  const agents = getAllAgentDefinitions();
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) {
    throw new Error(`Agent "${agentId}" not found`);
  }

  const containerImage = getProviderImage(agent.provider);
  if (!containerImage) {
    throw new Error(
      `No container image for provider "${agent.provider}" (agent "${agentId}")`,
    );
  }

  return {
    containerImage,
    secretKeys: agent.secretKeys,
  };
}
