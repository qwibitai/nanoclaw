import path from 'path';

export const WORKSPACE_IPC =
  process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
export const WORKSPACE_GROUP =
  process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
export const WORKSPACE_GLOBAL =
  process.env.NANOCLAW_GLOBAL_DIR || '/workspace/global';
export const WORKSPACE_EXTRA =
  process.env.NANOCLAW_EXTRA_DIR || '/workspace/extra';

export const IPC_INPUT_DIR = path.join(WORKSPACE_IPC, 'input');
export const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
export const IPC_POLL_MS = 500;
