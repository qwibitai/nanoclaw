import { vi } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from '../../db.js';
import type { Channel, NewMessage, RegisteredGroup } from '../../types.js';

export interface StubChannel extends Channel {
  sent: Array<{ jid: string; text: string }>;
  edits: Array<{ jid: string; messageId: number; text: string }>;
  streams: Array<{ jid: string; text: string }>;
  setOwnedJids: (jids: string[]) => void;
}

export function createStubChannel(opts?: {
  /** JIDs this channel owns. If not provided, the channel owns every JID. */
  ownedJids?: string[];
}): StubChannel {
  let owned: Set<string> | null = opts?.ownedJids
    ? new Set(opts.ownedJids)
    : null;
  let nextStreamId = 1;
  const sent: StubChannel['sent'] = [];
  const edits: StubChannel['edits'] = [];
  const streams: StubChannel['streams'] = [];

  return {
    name: 'stub',
    sent,
    edits,
    streams,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: () => true,
    ownsJid: (jid: string) => owned === null || owned.has(jid),
    sendMessage: vi.fn(async (jid: string, text: string) => {
      sent.push({ jid, text });
    }),
    setTyping: vi.fn(async () => {}),
    sendStreamMessage: vi.fn(async (jid: string, text: string) => {
      const id = nextStreamId++;
      streams.push({ jid, text });
      return id;
    }),
    editMessage: vi.fn(async (jid: string, messageId: number, text: string) => {
      edits.push({ jid, messageId, text });
    }),
    deleteMessage: vi.fn(async () => {}),
    sendPhoto: vi.fn(async () => {}),
    setOwnedJids: (jids: string[]) => {
      owned = new Set(jids);
    },
  };
}

export function seedRegisteredGroup(
  group: Partial<RegisteredGroup> & {
    name: string;
    folder: string;
    jid: string;
  },
): RegisteredGroup {
  const full: RegisteredGroup = {
    name: group.name,
    folder: group.folder,
    trigger: group.trigger ?? '@Andy',
    added_at: group.added_at ?? '2026-01-01T00:00:00.000Z',
    isMain: group.isMain ?? false,
    requiresTrigger: group.requiresTrigger ?? false,
  };
  setRegisteredGroup(group.jid, full);
  return full;
}

export function createMessage(
  overrides: Partial<NewMessage> & { chat_jid: string; content: string },
): NewMessage {
  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 10)}`,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender ?? 'user@s.whatsapp.net',
    sender_name: overrides.sender_name ?? 'Alice',
    content: overrides.content,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    is_from_me: overrides.is_from_me ?? false,
    is_bot_message: overrides.is_bot_message ?? false,
  };
}

export function resetTestDatabase(): void {
  _initTestDatabase();
}
