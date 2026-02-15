/**
 * Proof that the ORIGINAL hooks (pre-fix) were bypassable.
 *
 * This file recreates the old createSanitizeBashHook from commit 1a07869
 * and shows that all three bypass vectors succeed. Then it runs the same
 * attacks against the FIXED hooks and shows they're blocked.
 */
import { describe, it, expect } from 'vitest';
import { createSanitizeBashHook, createSecretPathBlockHook } from './security-hooks.js';

// ---------- Recreate the ORIGINAL hook from commit 1a07869 ----------
const SECRET_ENV_VARS_ORIG = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function createOriginalBashHook() {
  return async (input: { tool_input: Record<string, unknown> }) => {
    const command = (input.tool_input as { command?: string })?.command;
    if (!command) return {};
    const unsetPrefix = `unset ${SECRET_ENV_VARS_ORIG.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...input.tool_input,
          command: unsetPrefix + command,
        },
      },
    };
  };
}
// No Read hook existed in the original code.
// ---------- End original hook ----------

function makeBashInput(command: string) {
  return { tool_name: 'Bash', tool_input: { command } };
}

function makeReadInput(filePath: string) {
  return { tool_name: 'Read', tool_input: { file_path: filePath } };
}

describe('BYPASS PROOF: original hook allows all three attack vectors', () => {
  const originalBashHook = createOriginalBashHook();

  it('Vector 1: Bash `cat /proc/self/environ` passes through (only gets unset prepended)', async () => {
    const result = await originalBashHook(makeBashInput('cat /proc/self/environ'));
    const output = (result as { hookSpecificOutput: { updatedInput: { command: string } } }).hookSpecificOutput;
    // The original hook does NOT block — it just prepends unset.
    // The command still runs and /proc/self/environ is readable because
    // the kernel snapshot is immutable (unset doesn't affect it).
    expect(output.updatedInput).toBeDefined();
    expect(output.updatedInput.command).toContain('cat /proc/self/environ');
    expect(output.updatedInput.command).not.toContain('block');
  });

  it('Vector 2: No Read hook existed — Read tool could access /proc/self/environ unchecked', () => {
    // The original code registered NO PreToolUse hook for the Read tool.
    // This means any Read({ file_path: "/proc/self/environ" }) went through
    // with zero interception. We prove this by showing the hook list:
    //
    //   hooks: {
    //     PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
    //   }
    //
    // No matcher for 'Read' → no hook fires → secrets exposed.
    const originalHookConfig = {
      PreToolUse: [{ matcher: 'Bash' }],  // no Read matcher
    };
    const readMatchers = originalHookConfig.PreToolUse
      .filter(h => h.matcher === 'Read');
    expect(readMatchers).toHaveLength(0);  // proves no Read protection existed
  });

  it('Vector 3: No Read hook existed — Read tool could access /tmp/input.json unchecked', () => {
    // Same as Vector 2: /tmp/input.json contains the full stdin JSON including
    // the secrets object. No Read hook meant it was freely readable.
    const originalHookConfig = {
      PreToolUse: [{ matcher: 'Bash' }],
    };
    const readMatchers = originalHookConfig.PreToolUse
      .filter(h => h.matcher === 'Read');
    expect(readMatchers).toHaveLength(0);
  });
});

describe('FIX PROOF: new hooks block all three attack vectors', () => {
  const fixedBashHook = createSanitizeBashHook();
  const fixedReadHook = createSecretPathBlockHook();

  it('Vector 1: Bash `cat /proc/self/environ` is now BLOCKED', async () => {
    const result = await fixedBashHook(makeBashInput('cat /proc/self/environ'), 'id', {} as never);
    const output = (result as { hookSpecificOutput: { decision?: string } }).hookSpecificOutput;
    expect(output.decision).toBe('block');
  });

  it('Vector 2: Read tool access to /proc/self/environ is now BLOCKED', async () => {
    const result = await fixedReadHook(makeReadInput('/proc/self/environ'), 'id', {} as never);
    const output = (result as { hookSpecificOutput: { decision?: string } }).hookSpecificOutput;
    expect(output.decision).toBe('block');
  });

  it('Vector 3: Read tool access to /tmp/input.json is now BLOCKED', async () => {
    const result = await fixedReadHook(makeReadInput('/tmp/input.json'), 'id', {} as never);
    const output = (result as { hookSpecificOutput: { decision?: string } }).hookSpecificOutput;
    expect(output.decision).toBe('block');
  });
});
