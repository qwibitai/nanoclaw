import { WebSocket } from 'ws';

import { logger } from '../logger.js';
import { redactSensitiveData } from '../redact.js';
import { getChatRoom, getChatRooms, type ChatMessage } from '../chat-db.js';
import { sendPushForMessage } from './push.js';

// ── In-memory client registry ──────────────────────────────────────────────
export interface WSClient {
  id: string;
  ws: WebSocket;
  identity: string;
  identity_type: 'user' | 'agent';
  room_id?: string;
  isAlive: boolean;
}

export const clients = new Map<string, WSClient>();

export function addClient(c: WSClient): void {
  clients.set(c.id, c);
}

export function removeClient(id: string): WSClient | undefined {
  const c = clients.get(id);
  clients.delete(id);
  return c;
}

interface MemberInfo {
  identity: string;
  identity_type: 'user' | 'agent';
}

// Track which rooms have an active agent (set via typing events from channel adapter)
const activeAgents = new Map<string, string>(); // roomId -> agent identity

export function getMemberList(roomId: string): MemberInfo[] {
  const seen = new Set<string>();
  const members: MemberInfo[] = [];
  for (const c of clients.values()) {
    if (c.room_id === roomId && !seen.has(c.identity)) {
      seen.add(c.identity);
      members.push({ identity: c.identity, identity_type: c.identity_type });
    }
  }
  if (activeAgents.has(roomId)) {
    const agentIdentity = activeAgents.get(roomId)!;
    if (!seen.has(agentIdentity)) {
      members.push({ identity: agentIdentity, identity_type: 'agent' });
    }
  }
  return members;
}

export function broadcast(
  roomId: string,
  msg: object,
  excludeId?: string,
): void {
  const isMessage = (msg as { type?: string }).type === 'message';
  // Redact sensitive data before sending to chat clients
  const outgoing = isMessage
    ? {
        ...msg,
        content: redactSensitiveData(
          (msg as { content?: string }).content || '',
        ),
      }
    : msg;
  const payload = JSON.stringify(outgoing);
  const notifyPayload = isMessage
    ? JSON.stringify({ type: 'unread', room_id: roomId })
    : '';
  for (const c of clients.values()) {
    if (c.id === excludeId || c.ws.readyState !== WebSocket.OPEN) continue;
    try {
      if (c.room_id === roomId) c.ws.send(payload);
      else if (isMessage) c.ws.send(notifyPayload);
    } catch {
      // Socket may have closed between readyState check and send
    }
  }
  // Fan out to Web Push subscriptions (offline devices). Fire-and-forget.
  if (isMessage) {
    const m = msg as { sender?: string; content?: string; id?: string };
    const room = getChatRoom(roomId);
    sendPushForMessage({
      roomId,
      roomName: room?.name || roomId,
      sender: m.sender || 'unknown',
      content: redactSensitiveData(m.content || ''),
      messageId: m.id,
    }).catch((err) =>
      logger.warn({ err: err.message }, 'sendPushForMessage failed'),
    );
  }
}

export function setAgentPresence(
  roomId: string,
  identity: string,
  active: boolean,
): void {
  const wasBefore = activeAgents.has(roomId);
  if (active) activeAgents.set(roomId, identity);
  else activeAgents.delete(roomId);
  const isNow = activeAgents.has(roomId);
  if (wasBefore !== isNow) {
    broadcast(roomId, {
      type: 'members',
      room_id: roomId,
      members: getMemberList(roomId),
    });
  }
}

export function broadcastRooms(): void {
  const payload = JSON.stringify({ type: 'rooms', rooms: getChatRooms() });
  for (const c of clients.values()) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
  }
}

// ── Message hook for channel adapter ──────────────────────────────────────
export type ChatMessageCallback = (roomId: string, message: ChatMessage) => void;

let onNewMessageCallback: ChatMessageCallback | null = null;
let onGroupUpdatedCallback: (() => void) | null = null;

export function setOnNewMessage(cb: ChatMessageCallback): void {
  onNewMessageCallback = cb;
}

export function clearOnNewMessage(): void {
  onNewMessageCallback = null;
}

export function getOnNewMessage(): ChatMessageCallback | null {
  return onNewMessageCallback;
}

export function setOnGroupUpdated(cb: () => void): void {
  onGroupUpdatedCallback = cb;
}

export function clearOnGroupUpdated(): void {
  onGroupUpdatedCallback = null;
}

export function getOnGroupUpdated(): (() => void) | null {
  return onGroupUpdatedCallback;
}
