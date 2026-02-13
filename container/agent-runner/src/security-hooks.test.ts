import { describe, it, expect } from 'vitest';
import { createSanitizeBashHook, createSecretPathBlockHook, SECRET_ENV_VARS } from './security-hooks.js';

// Minimal mock matching the SDK's PreToolUseHookInput shape
function makeBashInput(command: string) {
  return { tool_name: 'Bash', tool_input: { command } };
}

function makeReadInput(filePath: string) {
  return { tool_name: 'Read', tool_input: { file_path: filePath } };
}

describe('createSanitizeBashHook', () => {
  const hook = createSanitizeBashHook();

  it('prepends unset to normal commands', async () => {
    const result = await hook(makeBashInput('ls -la'), 'id', {} as never);
    const output = (result as { hookSpecificOutput: { updatedInput: { command: string } } }).hookSpecificOutput;
    expect(output.updatedInput.command).toContain('unset');
    expect(output.updatedInput.command).toContain('ANTHROPIC_API_KEY');
    expect(output.updatedInput.command).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(output.updatedInput.command.endsWith('ls -la')).toBe(true);
  });

  it('allows normal commands', async () => {
    const result = await hook(makeBashInput('npm test'), 'id', {} as never);
    const output = (result as { hookSpecificOutput: { updatedInput: { command: string } } }).hookSpecificOutput;
    expect(output.updatedInput).toBeDefined();
    expect(output.updatedInput.command).toContain('npm test');
  });

  it('blocks commands containing /proc/self/environ', async () => {
    const result = await hook(makeBashInput('cat /proc/self/environ'), 'id', {} as never);
    const output = (result as { hookSpecificOutput: { decision: string } }).hookSpecificOutput;
    expect(output.decision).toBe('block');
  });

  it('blocks commands containing /proc/<pid>/environ', async () => {
    const result = await hook(makeBashInput('cat /proc/1/environ'), 'id', {} as never);
    const output = (result as { hookSpecificOutput: { decision: string } }).hookSpecificOutput;
    expect(output.decision).toBe('block');
  });

  it('blocks /proc/*/environ even in compound commands', async () => {
    const result = await hook(makeBashInput('echo hi && cat /proc/self/environ | grep KEY'), 'id', {} as never);
    const output = (result as { hookSpecificOutput: { decision: string } }).hookSpecificOutput;
    expect(output.decision).toBe('block');
  });

  it('returns empty for missing command', async () => {
    const result = await hook({ tool_name: 'Bash', tool_input: {} }, 'id', {} as never);
    expect(result).toEqual({});
  });
});

describe('createSecretPathBlockHook', () => {
  const hook = createSecretPathBlockHook();

  it('blocks /proc/self/environ', async () => {
    const result = await hook(makeReadInput('/proc/self/environ'), 'id', {} as never);
    const output = (result as { hookSpecificOutput: { decision: string } }).hookSpecificOutput;
    expect(output.decision).toBe('block');
  });

  it('blocks /proc/1/environ', async () => {
    const result = await hook(makeReadInput('/proc/1/environ'), 'id', {} as never);
    const output = (result as { hookSpecificOutput: { decision: string } }).hookSpecificOutput;
    expect(output.decision).toBe('block');
  });

  it('blocks /tmp/input.json', async () => {
    const result = await hook(makeReadInput('/tmp/input.json'), 'id', {} as never);
    const output = (result as { hookSpecificOutput: { decision: string } }).hookSpecificOutput;
    expect(output.decision).toBe('block');
  });

  it('allows normal file paths', async () => {
    const result = await hook(makeReadInput('/workspace/group/file.txt'), 'id', {} as never);
    expect(result).toEqual({});
  });

  it('allows /proc paths that are not environ', async () => {
    const result = await hook(makeReadInput('/proc/self/status'), 'id', {} as never);
    expect(result).toEqual({});
  });

  it('allows /tmp paths that are not input.json', async () => {
    const result = await hook(makeReadInput('/tmp/other-file.txt'), 'id', {} as never);
    expect(result).toEqual({});
  });

  it('returns empty for missing file_path', async () => {
    const result = await hook({ tool_name: 'Read', tool_input: {} }, 'id', {} as never);
    expect(result).toEqual({});
  });
});

describe('SECRET_ENV_VARS', () => {
  it('contains expected keys', () => {
    expect(SECRET_ENV_VARS).toContain('ANTHROPIC_API_KEY');
    expect(SECRET_ENV_VARS).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });
});
