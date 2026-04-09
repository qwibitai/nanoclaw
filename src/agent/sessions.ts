/**
 * Agent session persistence — delegates to the Nexus Store.
 *
 * Previously read/wrote JSON files locally.
 * Now calls the store HTTP API for session ID mapping.
 */

import * as store from '../shared/store-client.ts';

export async function getSessionId(
  sessionId: string,
): Promise<string | undefined> {
  const agentSessionId = await store.getAgentSessionId(sessionId);
  return agentSessionId ?? undefined;
}

export async function saveSessionId(
  sessionId: string,
  agentSessionId: string,
): Promise<void> {
  await store.saveAgentSessionId(sessionId, agentSessionId);
}
