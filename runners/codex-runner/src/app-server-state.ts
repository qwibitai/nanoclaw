export interface AppServerAgentMessageItem {
  type: 'agentMessage';
  text?: string | null;
  phase?: 'commentary' | 'final_answer' | string | null;
}

export interface AppServerContextCompactionItem {
  type: 'contextCompaction';
  id?: string;
}

export type AppServerItem =
  | AppServerAgentMessageItem
  | AppServerContextCompactionItem
  | {
      type: string;
      [key: string]: unknown;
    };

export interface AppServerTurnState {
  turnId?: string;
  status: 'pending' | 'inProgress' | 'completed' | 'failed' | 'interrupted';
  finalAnswer: string | null;
  latestAgentMessage: string | null;
  errorMessage: string | null;
  compactionCompleted: boolean;
}

export type AppServerTurnEvent =
  | {
      method: 'turn/started';
      params?: { turn?: { id?: string | null; status?: string | null } };
    }
  | {
      method: 'turn/completed';
      params?: {
        turn?: {
          id?: string | null;
          status?: string | null;
          error?: { message?: string | null } | string | null;
        };
      };
    }
  | {
      method: 'item/completed';
      params?: { item?: AppServerItem | null };
    }
  | {
      method: 'error';
      params?: {
        error?: {
          message?: string | null;
          codexErrorInfo?: {
            httpStatusCode?: number | null;
            type?: string | null;
          } | null;
        } | null;
      };
    };

export function createInitialAppServerTurnState(): AppServerTurnState {
  return {
    status: 'pending',
    finalAnswer: null,
    latestAgentMessage: null,
    errorMessage: null,
    compactionCompleted: false,
  };
}

export function reduceAppServerTurnState(
  state: AppServerTurnState,
  event: AppServerTurnEvent,
): AppServerTurnState {
  if (event.method === 'turn/started') {
    return {
      ...state,
      turnId: event.params?.turn?.id || state.turnId,
      status: 'inProgress',
    };
  }

  if (event.method === 'item/completed') {
    const item = event.params?.item;
    if (!item) return state;

    if (item.type === 'agentMessage') {
      const text =
        typeof item.text === 'string' && item.text.trim().length > 0
          ? item.text
          : null;
      if (!text) return state;

      if (item.phase === 'final_answer') {
        return {
          ...state,
          finalAnswer: text,
          latestAgentMessage: text,
        };
      }

      return {
        ...state,
        latestAgentMessage: text,
      };
    }

    if (item.type === 'contextCompaction') {
      return {
        ...state,
        compactionCompleted: true,
      };
    }

    return state;
  }

  if (event.method === 'error') {
    const error = event.params?.error;
    const message =
      typeof error?.message === 'string' && error.message.trim().length > 0
        ? error.message.trim()
        : 'Codex app-server turn failed.';
    const httpStatusCode = error?.codexErrorInfo?.httpStatusCode;

    return {
      ...state,
      errorMessage:
        typeof httpStatusCode === 'number'
          ? `${message} (HTTP ${httpStatusCode})`
          : message,
    };
  }

  if (event.method === 'turn/completed') {
    const turn = event.params?.turn;
    const status =
      turn?.status === 'completed' ||
      turn?.status === 'failed' ||
      turn?.status === 'interrupted'
        ? turn.status
        : 'completed';
    const turnError =
      typeof turn?.error === 'string'
        ? turn.error
        : turn?.error?.message || null;

    return {
      ...state,
      turnId: turn?.id || state.turnId,
      status,
      errorMessage: turnError || state.errorMessage,
    };
  }

  return state;
}

export function isAppServerTurnFinished(state: AppServerTurnState): boolean {
  return (
    state.status === 'completed' ||
    state.status === 'failed' ||
    state.status === 'interrupted'
  );
}

export function getAppServerTurnResult(
  state: AppServerTurnState,
): string | null {
  return state.finalAnswer || state.latestAgentMessage;
}
