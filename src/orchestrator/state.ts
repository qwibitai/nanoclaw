import {
  getAllRegisteredGroups,
  getAllSessions,
  getLastBotMessageTimestamp,
  getRouterState,
  setRouterState,
} from '../db.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';

export interface LastUsageEntry {
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  contextWindow?: number;
}

export interface RateLimitEntry {
  utilization?: number;
  resetsAt?: number;
  rateLimitType?: string;
}

/**
 * Mutable orchestrator state. Holds the in-memory view of what the
 * persistent store (SQLite router_state/sessions/registered_groups) knows.
 * Exposed as an object so every other orchestrator module can read and
 * mutate the same data without each relying on module-level `let`.
 */
export interface OrchestratorState {
  lastTimestamp: string;
  sessions: Record<string, string>;
  registeredGroups: Record<string, RegisteredGroup>;
  lastAgentTimestamp: Record<string, string>;
  messageLoopRunning: boolean;
  lastUsage: Record<string, LastUsageEntry>;
  compactCount: Record<string, number>;
  lastRateLimit: Record<string, RateLimitEntry>;
  compactPending: Set<string>;
  deferredCompact: Set<string>;
}

export function createState(): OrchestratorState {
  return {
    lastTimestamp: '',
    sessions: {},
    registeredGroups: {},
    lastAgentTimestamp: {},
    messageLoopRunning: false,
    lastUsage: {},
    compactCount: {},
    lastRateLimit: {},
    compactPending: new Set(),
    deferredCompact: new Set(),
  };
}

/** Hydrate `state` from the persistent store. */
export function loadState(state: OrchestratorState): void {
  state.lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    state.lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    state.lastAgentTimestamp = {};
  }
  state.sessions = getAllSessions();
  state.registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(state.registeredGroups).length },
    'State loaded',
  );
}

/** Persist the portion of `state` that lives in router_state. */
export function saveState(state: OrchestratorState): void {
  setRouterState('last_timestamp', state.lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(state.lastAgentTimestamp),
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot
 * reply if `lastAgentTimestamp` is missing (new group, corrupted state,
 * restart). Saves state back if a recovery was needed.
 */
export function getOrRecoverCursor(
  state: OrchestratorState,
  chatJid: string,
  assistantName: string,
): string {
  const existing = state.lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, assistantName);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    state.lastAgentTimestamp[chatJid] = botTs;
    saveState(state);
    return botTs;
  }
  return '';
}
