import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolvePendingInput } from './intent-classifier.js';
import { NewMessage } from './types.js';

function makeMessage(
  content: string,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: overrides.id ?? 'msg-1',
    chat_jid: overrides.chat_jid ?? 'group1@g.us',
    sender: overrides.sender ?? 'user-1',
    sender_name: overrides.sender_name ?? 'Konstantin',
    content,
    timestamp: overrides.timestamp ?? '2026-04-12T12:00:00.000Z',
    ...overrides,
  };
}

describe('resolvePendingInput', () => {
  beforeEach(() => {
    delete process.env.AI_INTENT_CLASSIFIER;
    delete process.env.AI_INTENT_CLASSIFIER_MODEL;
    delete process.env.AI_INTENT_CLASSIFIER_TIMEOUT_MS;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns heuristic classification when the message is already actionable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolvePendingInput(
      [makeMessage('filter them by 9 or 10 score')],
      'Idea Maze',
      {
        busyInteractiveContainer: true,
        lastAssistantMessage: 'You have 130 fresh candidates.',
      },
    );

    expect(result).toMatchObject({
      kind: 'workflow_reply',
      classifier: 'heuristic',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses Claude fallback for ambiguous follow-ups that would otherwise be ignored', async () => {
    process.env.AI_INTENT_CLASSIFIER = 'claude';
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              kind: 'workflow_reply',
              confidence: 0.91,
              reason: 'This is an actionable instruction about the previous answer.',
            }),
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolvePendingInput(
      [makeMessage('the rest should be removed')],
      'Idea Maze',
      {
        busyInteractiveContainer: true,
        lastAssistantMessage: 'The top candidates are 9, 10, and 11.',
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      kind: 'workflow_reply',
      classifier: 'ai',
    });
  });

  it('falls back to heuristic classification when Claude is disabled or unavailable', async () => {
    process.env.AI_INTENT_CLASSIFIER = 'off';

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolvePendingInput(
      [makeMessage('the rest should be removed')],
      'Idea Maze',
      {
        busyInteractiveContainer: true,
        lastAssistantMessage: 'The top candidates are 9, 10, and 11.',
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: 'chat',
      classifier: 'heuristic',
    });
  });
});
