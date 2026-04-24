import {
  createQueryLoopGuard,
  GuardAction,
  QueryLoopGuard,
} from './query-loop.js';

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface QueryRunnerMessage {
  type: 'assistant' | 'result' | 'system';
  subtype?: string;
  result?: string | null;
  session_id?: string;
  uuid?: string;
}

export interface PromptInput {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

type PromptDispatchListener = (prompt: string) => void;
type PromptQueuedListener = (prompt: string) => void;

interface QueuedPrompt {
  prompt: string;
  isRecovery: boolean;
}

export class PromptQueue implements AsyncIterable<PromptInput> {
  private queue: QueuedPrompt[] = [];
  private waiting: (() => void) | null = null;
  private done = false;
  private dispatchListener: PromptDispatchListener | null = null;
  private queuedListener: PromptQueuedListener | null = null;

  constructor(initialPrompt: string) {
    this.enqueuePrompt(initialPrompt);
  }

  setDispatchListener(listener: PromptDispatchListener): void {
    this.dispatchListener = listener;
  }

  setQueuedListener(listener: PromptQueuedListener): void {
    this.queuedListener = listener;
  }

  getQueuedUserPromptCount(): number {
    return this.queue.filter((entry) => !entry.isRecovery).length;
  }

  enqueuePrompt(prompt: string): void {
    this.queue.push({ prompt, isRecovery: false });
    this.queuedListener?.(prompt);
    this.waiting?.();
  }

  enqueuePriorityPrompt(prompt: string): void {
    this.queue.unshift({ prompt, isRecovery: true });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<PromptInput> {
    while (true) {
      while (this.queue.length > 0) {
        const entry = this.queue.shift()!;
        this.dispatchListener?.(entry.prompt);
        yield {
          type: 'user',
          message: { role: 'user', content: entry.prompt },
          parent_tool_use_id: null,
          session_id: '',
        };
      }

      if (this.done) {
        return;
      }

      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
      this.waiting = null;
    }
  }
}

interface RunQueryRunnerOptions {
  promptQueue: PromptQueue;
  messages: AsyncIterable<QueryRunnerMessage>;
  isScheduledTask: boolean;
  closedDuringQuery?: boolean;
  getClosedDuringQuery?: () => boolean;
  consumeSendMessageCount: () => number;
  onPromptDispatched?: (prompt: string) => void;
  writeOutput: (output: ContainerOutput) => Promise<void> | void;
}

interface RunQueryRunnerResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}

function applyGuardAction(
  action: GuardAction,
  promptQueue: PromptQueue,
  writeOutput: (output: ContainerOutput) => Promise<void> | void,
  newSessionId: string | undefined,
): Promise<void> | void {
  if (action.type === 'recover') {
    promptQueue.enqueuePriorityPrompt(action.prompt);
    return;
  }

  if (action.type === 'emit-error') {
    throw new Error(action.error);
  }

  if (action.type === 'emit-success') {
    return writeOutput({
      status: 'success',
      result: action.resultText,
      newSessionId,
    });
  }
}

function noteBoundaryDelivery(
  guard: QueryLoopGuard,
  consumeSendMessageCount: () => number,
): void {
  guard.noteSendMessageDelivery(consumeSendMessageCount() > 0);
}

function resolveClosedDuringQuery(options: RunQueryRunnerOptions): boolean {
  if (options.getClosedDuringQuery) {
    return options.getClosedDuringQuery();
  }

  return options.closedDuringQuery ?? false;
}

export async function runQueryRunner(
  options: RunQueryRunnerOptions,
): Promise<RunQueryRunnerResult> {
  const guard = createQueryLoopGuard({
    isScheduledTask: options.isScheduledTask,
  });

  for (let index = 0; index < options.promptQueue.getQueuedUserPromptCount(); index += 1) {
    guard.enqueueConversationalPrompt(`queued-prompt-${index}`);
  }

  options.promptQueue.setQueuedListener((prompt) => {
    guard.enqueueConversationalPrompt(prompt);
  });
  options.promptQueue.setDispatchListener((prompt) => {
    guard.markPromptDispatched();
    options.onPromptDispatched?.(prompt);
  });

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;

  for await (const message of options.messages) {
    if (message.type === 'assistant' && message.uuid) {
      lastAssistantUuid = message.uuid;
      continue;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      continue;
    }

    if (message.type !== 'result') {
      continue;
    }

    noteBoundaryDelivery(guard, options.consumeSendMessageCount);

    const action = guard.onResult({
      subtype: message.subtype ?? 'success',
      resultText: message.result ?? null,
    });

    await applyGuardAction(
      action,
      options.promptQueue,
      options.writeOutput,
      newSessionId,
    );
  }

  noteBoundaryDelivery(guard, options.consumeSendMessageCount);
  const closedDuringQuery = resolveClosedDuringQuery(options);
  const exitAction = guard.onQueryExit({
    closedDuringQuery,
  });
  await applyGuardAction(
    exitAction,
    options.promptQueue,
    options.writeOutput,
    newSessionId,
  );

  return {
    newSessionId,
    lastAssistantUuid,
    closedDuringQuery,
  };
}
