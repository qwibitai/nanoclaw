import { describe, expect, it } from 'vitest';

import {
  createQueryLoopGuard,
  NO_REPLY_RECOVERY_PROMPT,
  QUERY_EXIT_ERROR,
  RECOVERY_EXHAUSTED_ERROR,
} from './query-loop.js';

describe('createQueryLoopGuard', () => {
  it('resolves a conversational round when the final result has visible text', () => {
    const guard = createQueryLoopGuard({ isScheduledTask: false });

    guard.enqueueConversationalPrompt('user prompt');
    guard.markPromptDispatched();

    expect(
      guard.onResult({ subtype: 'success', resultText: 'visible reply' }),
    ).toEqual({ type: 'emit-success', resultText: 'visible reply' });
    expect(guard.onQueryExit({ closedDuringQuery: false })).toEqual({
      type: 'none',
    });
  });

  it('keeps later visible results attached to the same delivered round until the next queued prompt is actually dispatched', () => {
    const guard = createQueryLoopGuard({ isScheduledTask: false });

    guard.enqueueConversationalPrompt('first prompt');
    guard.enqueueConversationalPrompt('second prompt');
    guard.markPromptDispatched();

    expect(
      guard.onResult({ subtype: 'success', resultText: 'first visible reply' }),
    ).toEqual({ type: 'emit-success', resultText: 'first visible reply' });
    expect(
      guard.onResult({
        subtype: 'success',
        resultText: 'second visible reply in same round',
      }),
    ).toEqual({
      type: 'emit-success',
      resultText: 'second visible reply in same round',
    });

    guard.markPromptDispatched();

    expect(
      guard.onResult({ subtype: 'success', resultText: 'next round reply' }),
    ).toEqual({ type: 'emit-success', resultText: 'next round reply' });
  });

  it('does not trigger recovery when a later result is empty but the current round already delivered visible output', () => {
    const guard = createQueryLoopGuard({ isScheduledTask: false });

    guard.enqueueConversationalPrompt('user prompt');
    guard.markPromptDispatched();

    expect(
      guard.onResult({ subtype: 'success', resultText: 'visible reply' }),
    ).toEqual({ type: 'emit-success', resultText: 'visible reply' });
    expect(guard.onResult({ subtype: 'success', resultText: '   ' })).toEqual({
      type: 'none',
    });
  });

  it('retries a conversational round once when a success result is empty or internal-only', () => {
    const guard = createQueryLoopGuard({ isScheduledTask: false });

    guard.enqueueConversationalPrompt('user prompt');
    guard.markPromptDispatched();

    expect(guard.onResult({ subtype: 'success', resultText: '   ' })).toEqual({
      type: 'recover',
      prompt: NO_REPLY_RECOVERY_PROMPT,
    });

    const secondGuard = createQueryLoopGuard({ isScheduledTask: false });
    secondGuard.enqueueConversationalPrompt('user prompt');
    secondGuard.markPromptDispatched();

    expect(
      secondGuard.onResult({
        subtype: 'success',
        resultText: '<internal>secret</internal>',
      }),
    ).toEqual({
      type: 'recover',
      prompt: NO_REPLY_RECOVERY_PROMPT,
    });
  });

  it('returns an explicit error after a second silent success result', () => {
    const guard = createQueryLoopGuard({ isScheduledTask: false });

    guard.enqueueConversationalPrompt('user prompt');
    guard.markPromptDispatched();

    expect(guard.onResult({ subtype: 'success', resultText: '' })).toEqual({
      type: 'recover',
      prompt: NO_REPLY_RECOVERY_PROMPT,
    });

    guard.markPromptDispatched();

    expect(
      guard.onResult({
        subtype: 'success',
        resultText: '<internal>still hidden</internal>',
      }),
    ).toEqual({
      type: 'emit-error',
      error: RECOVERY_EXHAUSTED_ERROR,
    });
  });

  it('counts non-empty send_message as delivery and skips recovery', () => {
    const guard = createQueryLoopGuard({ isScheduledTask: false });

    guard.enqueueConversationalPrompt('user prompt');
    guard.markPromptDispatched();
    guard.noteSendMessageDelivery(true);

    expect(guard.onResult({ subtype: 'success', resultText: ' ' })).toEqual({
      type: 'none',
    });
  });

  it('does not count blank send_message activity as delivery', () => {
    const guard = createQueryLoopGuard({ isScheduledTask: false });

    guard.enqueueConversationalPrompt('user prompt');
    guard.markPromptDispatched();
    guard.noteSendMessageDelivery(false);

    expect(guard.onResult({ subtype: 'success', resultText: ' ' })).toEqual({
      type: 'recover',
      prompt: NO_REPLY_RECOVERY_PROMPT,
    });
  });

  it('does not carry send_message delivery from one resolved round into the next round', () => {
    const guard = createQueryLoopGuard({ isScheduledTask: false });

    guard.enqueueConversationalPrompt('first prompt');
    guard.enqueueConversationalPrompt('second prompt');
    guard.markPromptDispatched();
    guard.noteSendMessageDelivery(true);

    expect(guard.onResult({ subtype: 'success', resultText: '' })).toEqual({
      type: 'none',
    });

    guard.markPromptDispatched();

    expect(guard.onResult({ subtype: 'success', resultText: '' })).toEqual({
      type: 'recover',
      prompt: NO_REPLY_RECOVERY_PROMPT,
    });
  });

  it('treats SDK error_* results as explicit errors without recovery', () => {
    const guard = createQueryLoopGuard({ isScheduledTask: false });

    guard.enqueueConversationalPrompt('user prompt');
    guard.markPromptDispatched();

    expect(
      guard.onResult({
        subtype: 'error_during_execution',
        resultText: 'sdk failed',
      }),
    ).toEqual({
      type: 'emit-error',
      error: 'Claude query returned error_during_execution: sdk failed',
    });
  });

  it('returns an explicit error when query exits with an accepted conversational round and no result', () => {
    const guard = createQueryLoopGuard({ isScheduledTask: false });

    guard.enqueueConversationalPrompt('user prompt');
    guard.markPromptDispatched();

    expect(guard.onQueryExit({ closedDuringQuery: false })).toEqual({
      type: 'emit-error',
      error: QUERY_EXIT_ERROR,
    });
  });

  it('returns an explicit error when close-sentinel shutdown ends an unresolved conversational round', () => {
    const guard = createQueryLoopGuard({ isScheduledTask: false });

    guard.enqueueConversationalPrompt('user prompt');
    guard.markPromptDispatched();

    expect(guard.onQueryExit({ closedDuringQuery: true })).toEqual({
      type: 'emit-error',
      error: QUERY_EXIT_ERROR,
    });
  });

  it('allows scheduled-task rounds to finish silently on success results and query exit', () => {
    const guard = createQueryLoopGuard({ isScheduledTask: true });

    guard.enqueueConversationalPrompt('scheduled prompt');
    guard.markPromptDispatched();

    expect(guard.onResult({ subtype: 'success', resultText: '' })).toEqual({
      type: 'none',
    });
    expect(guard.onQueryExit({ closedDuringQuery: false })).toEqual({
      type: 'none',
    });
  });

  it('applies the same guard to follow-up IPC prompts on an existing session', () => {
    const guard = createQueryLoopGuard({ isScheduledTask: false });

    guard.enqueueConversationalPrompt('first prompt');
    guard.enqueueConversationalPrompt('follow-up prompt');
    guard.markPromptDispatched();

    expect(
      guard.onResult({ subtype: 'success', resultText: 'visible reply' }),
    ).toEqual({ type: 'emit-success', resultText: 'visible reply' });

    guard.markPromptDispatched();

    expect(guard.onResult({ subtype: 'success', resultText: '' })).toEqual({
      type: 'recover',
      prompt: NO_REPLY_RECOVERY_PROMPT,
    });
  });
});
