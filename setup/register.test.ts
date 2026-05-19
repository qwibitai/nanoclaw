/**
 * Unit tests for the assistant-name rename pass in setup/register.ts.
 *
 * register.ts updates per-group CLAUDE.md files when ASSISTANT_NAME changes
 * away from the "Andy" default. Originally it only rewrote the `# Andy`
 * heading and `You are Andy` identity line, missing the `@Andy` trigger
 * references that scheduled-task examples ship with (see groups/main/CLAUDE.md
 * lines 153 and 199, which use `"trigger": "@Andy"`). That left a renamed
 * install with two different assistant names in the same file.
 *
 * Tests the regex chain in isolation so we can pin the word-boundary anchor
 * without spinning up the full register.run() flow (DB init, migrations,
 * channel wiring, etc).
 */
import { describe, expect, it } from 'vitest';

function applyAssistantNameRename(content: string, assistantName: string): string {
  let result = content;
  result = result.replace(/^# Andy$/m, `# ${assistantName}`);
  result = result.replace(/You are Andy/g, `You are ${assistantName}`);
  // Word-boundary anchor — see register.ts:226.
  result = result.replace(/@Andy\b/g, `@${assistantName}`);
  return result;
}

describe('assistant-name rename pass (#1870)', () => {
  it('replaces @Andy trigger references alongside heading and identity rewrites', () => {
    const source = [
      '# Andy',
      '',
      'You are Andy.',
      '',
      'Scheduled tasks:',
      '```json',
      '[',
      '  { "trigger": "@Andy", "prompt": "daily digest" },',
      '  { "trigger": "@Andy", "prompt": "weekly review" }',
      ']',
      '```',
    ].join('\n');

    const renamed = applyAssistantNameRename(source, 'Ruby');

    expect(renamed).toContain('# Ruby');
    expect(renamed).toContain('You are Ruby.');
    expect(renamed).not.toContain('@Andy');
    expect(renamed).toContain('"trigger": "@Ruby"');
  });

  it('preserves names that happen to start with "Andy" via the word-boundary anchor', () => {
    // Without \b, /@Andy/g would rewrite "@Andyville" to "@Rubyville" — a
    // false positive. Pin the boundary behavior here so a future relax can't
    // silently re-introduce that regression.
    expect(applyAssistantNameRename('mention @Andyville here', 'Ruby')).toBe(
      'mention @Andyville here',
    );
    expect(applyAssistantNameRename('mention @AndyBot here', 'Ruby')).toBe(
      'mention @AndyBot here',
    );
  });

  it('renames @Andy at end of line, end of string, and surrounded by punctuation', () => {
    expect(applyAssistantNameRename('hey @Andy how are you', 'Ruby')).toBe(
      'hey @Ruby how are you',
    );
    expect(applyAssistantNameRename('"@Andy"', 'Ruby')).toBe('"@Ruby"');
    expect(applyAssistantNameRename('@Andy.', 'Ruby')).toBe('@Ruby.');
    expect(applyAssistantNameRename('@Andy,', 'Ruby')).toBe('@Ruby,');
    expect(applyAssistantNameRename('@Andy', 'Ruby')).toBe('@Ruby');
  });

  it('handles multi-word and punctuation-containing assistant names', () => {
    const source = [
      '# Andy',
      'You are Andy.',
      'Trigger: @Andy',
    ].join('\n');

    const renamed = applyAssistantNameRename(source, 'C.L.A.U.D.E.');

    expect(renamed).toContain('# C.L.A.U.D.E.');
    expect(renamed).toContain('You are C.L.A.U.D.E.');
    expect(renamed).toContain('@C.L.A.U.D.E.');
  });

  it('is a no-op when no Andy references are present', () => {
    const source = '# Ruby\nYou are Ruby.\nTrigger: @Ruby';
    expect(applyAssistantNameRename(source, 'Ruby')).toBe(source);
  });

  it('does not touch unrelated @mentions of other users', () => {
    expect(applyAssistantNameRename('cc @alice and @bob', 'Ruby')).toBe(
      'cc @alice and @bob',
    );
  });
});
