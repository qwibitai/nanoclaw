// Security hooks for the agent runner.
//
// - createSanitizeBashHook: strips secret env vars from Bash subprocesses
//   and blocks commands that attempt to read /proc/{pid}/environ.
// - createSecretPathBlockHook: blocks Read tool access to paths that could
//   leak secrets (/proc/{pid}/environ, /tmp/input.json).

import { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

// Environment variables that must never be visible to tool subprocesses.
export const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

// Matches /proc/<pid>/environ where <pid> is "self" or digits.
const PROC_ENVIRON_RE = /\/proc\/(self|\d+)\/environ/;

// PreToolUse hook for the Bash tool.
//
// 1. Prepends `unset <SECRET_ENV_VARS>` so child processes can't read them
//    from the shell environment.
// 2. Rejects commands that try to read /proc/{pid}/environ, which would
//    bypass the unset since the kernel snapshot is immutable.
export function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    // Block commands that attempt to read /proc/*/environ
    if (PROC_ENVIRON_RE.test(command)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          decision: 'block',
          reason: 'Access to /proc/*/environ is blocked for security reasons.',
        },
      };
    }

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

// PreToolUse hook for the Read tool.
//
// Blocks read access to paths that could leak secrets:
// - /proc/{pid}/environ (kernel env snapshot, immutable after process start)
// - /tmp/input.json (stdin dump containing secrets)
export function createSecretPathBlockHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const filePath = (preInput.tool_input as { file_path?: string })?.file_path;
    if (!filePath) return {};

    if (PROC_ENVIRON_RE.test(filePath)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          decision: 'block',
          reason: 'Access to /proc/*/environ is blocked for security reasons.',
        },
      };
    }

    if (filePath === '/tmp/input.json' || filePath.startsWith('/tmp/input.json/')) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          decision: 'block',
          reason: 'Access to /tmp/input.json is blocked for security reasons.',
        },
      };
    }

    return {};
  };
}
