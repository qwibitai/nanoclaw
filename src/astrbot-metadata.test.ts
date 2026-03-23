import { describe, expect, it } from 'vitest';

import {
  isAstrBotWakeMessage,
  isContextOnlyMessage,
} from './astrbot-metadata.js';
import { NewMessage } from './types.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'm1',
    chat_jid: 'astrbot:test',
    sender: 'u1',
    sender_name: 'User 1',
    content: 'hello',
    timestamp: '2026-03-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('astrbot metadata helpers', () => {
  it('detects context-only messages from metadata', () => {
    expect(
      isContextOnlyMessage(
        makeMsg({ metadata: { source: 'astrbot', context_only: true } }),
      ),
    ).toBe(true);
  });

  it('does not treat normal messages as context-only', () => {
    expect(
      isContextOnlyMessage(
        makeMsg({ metadata: { source: 'astrbot', context_only: false } }),
      ),
    ).toBe(false);
    expect(isContextOnlyMessage(makeMsg())).toBe(false);
  });

  it('detects astrbot wake metadata as an explicit trigger signal', () => {
    expect(
      isAstrBotWakeMessage(
        makeMsg({
          metadata: { source: 'astrbot', is_at_or_wake_command: true },
        }),
      ),
    ).toBe(true);
  });

  it('ignores wake flags from non-astrbot sources', () => {
    expect(
      isAstrBotWakeMessage(
        makeMsg({
          metadata: { source: 'telegram', is_at_or_wake_command: true },
        }),
      ),
    ).toBe(false);
    expect(isAstrBotWakeMessage(makeMsg())).toBe(false);
  });
});
