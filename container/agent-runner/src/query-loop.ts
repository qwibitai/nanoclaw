import { hasVisibleReply } from './delivery-activity.js';

export const NO_REPLY_RECOVERY_PROMPT =
  "You completed work for the user's last message but no reply was delivered. Finish.";

export const RECOVERY_EXHAUSTED_ERROR =
  'Conversational turn completed without a delivered reply after one recovery attempt';

export const QUERY_EXIT_ERROR =
  'Conversational turn ended without a delivered reply before the query exited';

export type GuardAction =
  | { type: 'none' }
  | { type: 'emit-success'; resultText: string | null }
  | { type: 'recover'; prompt: string }
  | { type: 'emit-error'; error: string };

interface ActiveRound {
  delivered: boolean;
  recoveryAttempted: boolean;
}

interface QueryLoopOptions {
  isScheduledTask: boolean;
}

interface QueryResult {
  subtype: string;
  resultText: string | null | undefined;
}

interface QueryExit {
  closedDuringQuery: boolean;
}

export interface QueryLoopGuard {
  enqueueConversationalPrompt(prompt: string): void;
  markPromptDispatched(): void;
  noteSendMessageDelivery(delivered: boolean): void;
  onResult(result: QueryResult): GuardAction;
  onQueryExit(exit: QueryExit): GuardAction;
}

function formatSdkError(result: QueryResult): string {
  const detail = typeof result.resultText === 'string' ? result.resultText.trim() : '';
  return detail
    ? `Claude query returned ${result.subtype}: ${detail}`
    : `Claude query returned ${result.subtype}`;
}

export function createQueryLoopGuard(
  options: QueryLoopOptions,
): QueryLoopGuard {
  let queuedPromptCount = 0;
  let recoveryPromptQueued = false;
  let activeRound: ActiveRound | null = null;

  function startNextQueuedRound(): void {
    if (queuedPromptCount === 0) return;
    queuedPromptCount -= 1;
    activeRound = { delivered: false, recoveryAttempted: false };
  }

  return {
    enqueueConversationalPrompt(_prompt: string): void {
      queuedPromptCount += 1;
    },

    markPromptDispatched(): void {
      if (recoveryPromptQueued) {
        recoveryPromptQueued = false;
        return;
      }

      if (activeRound === null) {
        startNextQueuedRound();
        return;
      }

      if (activeRound.delivered) {
        startNextQueuedRound();
      }
    },

    noteSendMessageDelivery(delivered: boolean): void {
      if (!delivered || activeRound === null) return;
      activeRound.delivered = true;
    },

    onResult(result: QueryResult): GuardAction {
      if (result.subtype.startsWith('error_')) {
        return { type: 'emit-error', error: formatSdkError(result) };
      }

      if (result.subtype !== 'success') {
        return { type: 'none' };
      }

      if (hasVisibleReply(result.resultText)) {
        if (activeRound !== null) {
          activeRound.delivered = true;
        }
        return {
          type: 'emit-success',
          resultText: result.resultText ?? null,
        };
      }

      if (options.isScheduledTask || activeRound?.delivered) {
        return { type: 'none' };
      }

      if (activeRound === null) {
        return { type: 'none' };
      }

      if (activeRound.recoveryAttempted) {
        return { type: 'emit-error', error: RECOVERY_EXHAUSTED_ERROR };
      }

      activeRound.recoveryAttempted = true;
      recoveryPromptQueued = true;

      return { type: 'recover', prompt: NO_REPLY_RECOVERY_PROMPT };
    },

    onQueryExit(_exit: QueryExit): GuardAction {
      if (!options.isScheduledTask && activeRound !== null && !activeRound.delivered) {
        return { type: 'emit-error', error: QUERY_EXIT_ERROR };
      }

      return { type: 'none' };
    },
  };
}
