import path from 'path';

export const WORKSPACE_ROOT =
  process.env.NANOCLAW_WORKSPACE_ROOT ?? '/workspace';
export const IPC_DIR = path.join(WORKSPACE_ROOT, 'ipc');
