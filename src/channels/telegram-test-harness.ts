import { vi } from 'vitest';

import type { TelegramChannelOpts } from './telegram.js';

/**
 * Captured reference to the most recently constructed MockBot. Set from
 * inside the `grammy` vi.mock in each test file so the harness can read
 * the active bot without having to thread it through individual tests.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const botRef: { current: any } = { current: null };

export function createTestOpts(
  overrides?: Partial<TelegramChannelOpts>,
): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    getStatus: vi.fn(() => ({
      activeContainers: 1,
      uptimeSeconds: 9240,
      sessions: { 'test-group': 'session-abc123-def456' },
      lastUsage: {
        'test-group': {
          inputTokens: 45200,
          outputTokens: 3100,
          numTurns: 12,
          contextWindow: 200000,
        },
      },
      compactCount: { 'test-group': 2 },
      lastRateLimit: {
        'test-group': {
          utilization: 0.35,
          resetsAt: 1744531200,
          rateLimitType: 'seven_day',
        },
      },
    })),
    sendIpcMessage: vi.fn(() => true),
    clearSession: vi.fn(),
    ...overrides,
  };
}

export function createTextCtx(overrides: {
  chatId?: number;
  chatType?: string;
  chatTitle?: string;
  text: string;
  fromId?: number;
  firstName?: string;
  username?: string;
  messageId?: number;
  date?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entities?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reply_to_message?: any;
}) {
  const chatId = overrides.chatId ?? 100200300;
  const chatType = overrides.chatType ?? 'group';
  return {
    chat: {
      id: chatId,
      type: chatType,
      title: overrides.chatTitle ?? 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: overrides.username ?? 'alice_user',
    },
    message: {
      text: overrides.text,
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      entities: overrides.entities ?? [],
      reply_to_message: overrides.reply_to_message,
    },
    me: { username: 'andy_ai_bot' },
    reply: vi.fn(),
  };
}

export function createMediaCtx(overrides: {
  chatId?: number;
  chatType?: string;
  fromId?: number;
  firstName?: string;
  date?: number;
  messageId?: number;
  caption?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra?: Record<string, any>;
}) {
  const chatId = overrides.chatId ?? 100200300;
  return {
    chat: {
      id: chatId,
      type: overrides.chatType ?? 'group',
      title: 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: 'alice_user',
    },
    message: {
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      caption: overrides.caption,
      ...(overrides.extra || {}),
    },
    me: { username: 'andy_ai_bot' },
  };
}

export function currentBot() {
  return botRef.current;
}

export async function triggerTextMessage(
  ctx: ReturnType<typeof createTextCtx>,
) {
  const handlers = currentBot().filterHandlers.get('message:text') || [];
  for (const h of handlers) await h(ctx);
}

export async function triggerMediaMessage(
  filter: string,
  ctx: ReturnType<typeof createMediaCtx>,
) {
  const handlers = currentBot().filterHandlers.get(filter) || [];
  for (const h of handlers) await h(ctx);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createEditedLocationCtx(location: Record<string, any>) {
  return {
    chat: { id: 100200300, type: 'group', title: 'Test Group' },
    from: { id: 99001, first_name: 'Alice', username: 'alice_user' },
    editedMessage: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      location,
    },
    me: { username: 'andy_ai_bot' },
  };
}

export async function triggerEditedLocationMessage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
) {
  const handlers =
    currentBot().filterHandlers.get('edited_message:location') || [];
  for (const h of handlers) await h(ctx);
}

export const flushPromises = () =>
  new Promise((resolve) => setTimeout(resolve, 0));
