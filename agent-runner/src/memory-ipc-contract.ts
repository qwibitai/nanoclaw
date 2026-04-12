export const MEMORY_IPC_ACTIONS = [
  'memory_search',
  'memory_save',
  'memory_patch',
  'memory_consolidate',
  'memory_dream',
  'procedure_save',
  'procedure_patch',
] as const;

export type MemoryIpcAction = (typeof MEMORY_IPC_ACTIONS)[number];

export interface MemoryIpcRequest {
  requestId: string;
  action: MemoryIpcAction;
  payload: Record<string, unknown>;
}

export interface MemoryIpcResponse {
  ok: boolean;
  requestId: string;
  provider?: string;
  data?: unknown;
  error?: string;
}
