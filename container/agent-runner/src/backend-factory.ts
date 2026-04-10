/**
 * Backend factory — returns the appropriate RunnerBackend based on env config.
 */

import type { RunnerBackend } from './runner-backend.js';
import { ClaudeCliBackend } from './claude-cli-backend.js';

/**
 * Create a RunnerBackend based on the AGENT_RUNNER_BACKEND env var.
 * Default: 'claude' (Claude CLI).
 */
export function createBackend(): RunnerBackend {
  const backendName = process.env.AGENT_RUNNER_BACKEND || 'claude';

  switch (backendName) {
    case 'claude':
      return new ClaudeCliBackend();
    default:
      throw new Error(`Unknown runner backend: "${backendName}". Supported: claude`);
  }
}
