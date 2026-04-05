import { createClaudeCodeProvider } from './claude-code/host.js';
import { createCodexProvider } from './codex/host.js';
import type { AgentProvider } from '../provider-types.js';

export const builtInProviders: readonly AgentProvider[] = [
  createClaudeCodeProvider(),
  createCodexProvider(),
];
