/**
 * HTTP client for the Nexus Store.
 *
 * Used by both gateway and agent to read/write session data.
 * The store's backing implementation (filesystem, Tigris+Postgres)
 * is invisible to callers.
 */

import type { ActivityEvent, ChannelType, Session } from './types.ts';
import { logger } from './logger.ts';

let storeUrl = 'http://localhost:3002';

export function setStoreUrl(url: string): void {
  storeUrl = url;
}

async function storeRequest(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${storeUrl}${path}`, options);
}

export async function listSessions(): Promise<Session[]> {
  const res = await storeRequest('/sessions');
  return (await res.json()) as Session[];
}

export async function getSession(id: string): Promise<Session | null> {
  const res = await storeRequest(`/sessions/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  return (await res.json()) as Session;
}

export async function getOrCreateSession(
  channelType: ChannelType,
  channelId: string,
): Promise<Session> {
  const res = await storeRequest('/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelType, channelId }),
  });
  return (await res.json()) as Session;
}

export async function touchSession(id: string): Promise<void> {
  await storeRequest(`/sessions/${encodeURIComponent(id)}/touch`, {
    method: 'PUT',
  });
}

export async function getAgentSessionId(
  id: string,
): Promise<string | null> {
  try {
    const res = await storeRequest(
      `/sessions/${encodeURIComponent(id)}/agent-session`,
    );
    const data = (await res.json()) as { agentSessionId: string | null };
    return data.agentSessionId;
  } catch {
    return null;
  }
}

export async function saveAgentSessionId(
  id: string,
  agentSessionId: string,
): Promise<void> {
  await storeRequest(
    `/sessions/${encodeURIComponent(id)}/agent-session`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentSessionId }),
    },
  );
}

export async function deleteSession(id: string): Promise<void> {
  await storeRequest(`/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// --- JSONL ---

export async function saveJsonl(
  sessionId: string,
  content: Uint8Array,
): Promise<void> {
  await storeRequest(
    `/sessions/${encodeURIComponent(sessionId)}/jsonl`,
    { method: 'PUT', body: content as unknown as BodyInit },
  );
}

export async function getJsonl(
  sessionId: string,
): Promise<Uint8Array | null> {
  const res = await storeRequest(
    `/sessions/${encodeURIComponent(sessionId)}/jsonl`,
  );
  if (res.status === 404) return null;
  return new Uint8Array(await res.arrayBuffer());
}

export async function getMessages(
  sessionId: string,
): Promise<{ role: string; content: string }[]> {
  const res = await storeRequest(
    `/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
  return (await res.json()) as { role: string; content: string }[];
}

// --- Events ---

export async function logEvent(
  event: Omit<ActivityEvent, 'id' | 'timestamp'>,
): Promise<ActivityEvent> {
  const res = await storeRequest('/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  return (await res.json()) as ActivityEvent;
}

export async function listEvents(count = 50): Promise<ActivityEvent[]> {
  const res = await storeRequest(`/events?count=${count}`);
  return (await res.json()) as ActivityEvent[];
}

/**
 * Check if the store is reachable. Used at startup to verify connectivity.
 */
export async function checkStore(): Promise<boolean> {
  try {
    const res = await storeRequest('/health');
    return res.ok;
  } catch (err) {
    logger.warn({ err }, 'Store not reachable');
    return false;
  }
}
