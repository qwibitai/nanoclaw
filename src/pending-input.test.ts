import { describe, expect, it } from 'vitest';

import { classifyPendingInput } from './pending-input.js';
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
    timestamp: overrides.timestamp ?? '2026-04-08T12:00:00.000Z',
    ...overrides,
  };
}

describe('classifyPendingInput', () => {
  it('classifies explicit commands as command input', () => {
    expect(classifyPendingInput([makeMessage('pipeline status')], 'Idea Maze')).toEqual({
      source: 'user',
      kind: 'command',
    });
    expect(
      classifyPendingInput(
        [makeMessage('run /research-opportunity on top 3 candidates')],
        'Idea Maze',
      ),
    ).toEqual({
      source: 'user',
      kind: 'command',
    });
  });

  it('classifies review decisions as workflow replies', () => {
    expect(classifyPendingInput([makeMessage('approve 9 11')], 'Idea Maze')).toEqual({
      source: 'user',
      kind: 'workflow_reply',
    });
    expect(classifyPendingInput([makeMessage('reject run 10')], 'Idea Maze')).toEqual({
      source: 'user',
      kind: 'workflow_reply',
    });
  });

  it('classifies short reply-to-assistant selections as workflow replies', () => {
    expect(
      classifyPendingInput(
        [
          makeMessage('9 11', {
            reply_to_message_id: 'assistant-1',
            reply_to_sender_name: 'Idea Maze',
          }),
        ],
        'Idea Maze',
      ),
    ).toEqual({
      source: 'user',
      kind: 'workflow_reply',
    });
  });

  it('treats ordinary chat as chat input', () => {
    expect(classifyPendingInput([makeMessage('thanks, looks good')], 'Idea Maze')).toEqual({
      source: 'user',
      kind: 'chat',
    });
  });

  it('keeps the highest-priority actionable kind across a batch', () => {
    expect(
      classifyPendingInput(
        [
          makeMessage('thanks'),
          makeMessage('approve 9', { id: 'msg-2' }),
        ],
        'Idea Maze',
      ),
    ).toEqual({
      source: 'user',
      kind: 'workflow_reply',
    });
  });
});
