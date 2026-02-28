import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handleHostCommand } from './host-commands.js';

let sendMessage: (jid: string, text: string) => Promise<void>;
let sendMessageCalls: Array<{ jid: string; text: string }>;

beforeEach(() => {
  sendMessageCalls = [];
  sendMessage = async (jid: string, text: string) => {
    sendMessageCalls.push({ jid, text });
  };
});

// --- type routing ---

describe('handleHostCommand type routing', () => {
  it('returns false for unknown type', async () => {
    const result = await handleHostCommand(
      { type: 'unknown_command' },
      'main',
      true,
      sendMessage,
    );
    expect(result).toBe(false);
    expect(sendMessageCalls).toHaveLength(0);
  });

  it('returns true for update_project', async () => {
    const result = await handleHostCommand(
      { type: 'update_project' },
      'main',
      true,
      sendMessage,
    );
    expect(result).toBe(true);
  });
});

// --- authorization ---

describe('handleHostCommand authorization', () => {
  it('blocks non-main group', async () => {
    const result = await handleHostCommand(
      { type: 'update_project', chatJid: 'other@g.us' },
      'other-group',
      false,
      sendMessage,
    );
    expect(result).toBe(true);
    expect(sendMessageCalls).toHaveLength(0);
  });
});

// --- dedup window ---

describe('handleHostCommand dedup', () => {
  it('ignores duplicate requests within dedup window', async () => {
    // First call should proceed
    await handleHostCommand(
      { type: 'update_project' },
      'main',
      true,
      sendMessage,
    );

    // Second call within 30s should be deduped (no additional sendMessage calls)
    const callsBefore = sendMessageCalls.length;
    const result = await handleHostCommand(
      { type: 'update_project' },
      'main',
      true,
      sendMessage,
    );
    expect(result).toBe(true);
    expect(sendMessageCalls).toHaveLength(callsBefore);
  });
});

// --- chatJid validation ---

describe('handleHostCommand chatJid validation', () => {
  it('does not send messages when chatJid is invalid', async () => {
    await handleHostCommand(
      { type: 'update_project', chatJid: 'no-at-sign' },
      'main',
      true,
      sendMessage,
    );
    expect(sendMessageCalls).toHaveLength(0);
  });

  it('does not send messages when chatJid is missing', async () => {
    await handleHostCommand(
      { type: 'update_project' },
      'main',
      true,
      sendMessage,
    );
    expect(sendMessageCalls).toHaveLength(0);
  });
});
