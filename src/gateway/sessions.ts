import type { ChannelType, Session } from '../shared/types.ts';

const sessions = new Map<string, Session>();

function makeSessionId(channelType: ChannelType, channelId: string): string {
  return `${channelType}-${channelId}`;
}

export function getOrCreateSession(
  channelType: ChannelType,
  channelId: string,
): Session {
  const id = makeSessionId(channelType, channelId);
  let session = sessions.get(id);
  if (!session) {
    session = {
      id,
      channelType,
      channelId,
      lastActivity: new Date().toISOString(),
      messageCount: 0,
    };
    sessions.set(id, session);
  }
  return session;
}

export function updateSessionAgent(
  sessionId: string,
  agentSessionId: string,
): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.agentSessionId = agentSessionId;
  }
}

export function touchSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastActivity = new Date().toISOString();
    session.messageCount++;
  }
}

export function getSessions(): Session[] {
  return [...sessions.values()];
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function getSessionCount(): number {
  return sessions.size;
}
