/**
 * Gateway session manager — thin wrapper over the store client.
 *
 * Previously held sessions in-memory (lost on restart).
 * Now delegates to the Nexus Store process for persistence.
 */

import type { ChannelType, Session } from '../shared/types.ts';
import * as store from '../shared/store-client.ts';

export async function getOrCreateSession(
  channelType: ChannelType,
  channelId: string,
): Promise<Session> {
  return store.getOrCreateSession(channelType, channelId);
}

export async function updateSessionAgent(
  sessionId: string,
  agentSessionId: string,
): Promise<void> {
  await store.saveAgentSessionId(sessionId, agentSessionId);
}

export async function touchSession(sessionId: string): Promise<void> {
  await store.touchSession(sessionId);
}

export async function getSessions(): Promise<Session[]> {
  return store.listSessions();
}

export function getSessionCount(): Promise<number> {
  return store.listSessions().then((s) => s.length);
}
