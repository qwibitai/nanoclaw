import { ClaudeRuntime } from './claude-runtime.js';
import { CodexRuntime } from './codex-runtime.js';
import { AgentRuntime, RuntimeHooks, RuntimeIpc } from './types.js';

export function createAgentRuntime(
  engine: 'claude' | 'codex' = 'claude',
  hooks: RuntimeHooks,
  ipc: RuntimeIpc,
): AgentRuntime {
  if (engine === 'codex') {
    return new CodexRuntime(hooks, ipc);
  }
  return new ClaudeRuntime(hooks, ipc);
}
