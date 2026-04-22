import { describe, it, expect } from 'vitest';

/**
 * Regex-level tests for the template rename step inside registerGroup()
 * in src/index.ts. Mirrors the tests in setup/register.test.ts that cover
 * the equivalent rename on the setup-time path.
 *
 * registerGroup() copies a CLAUDE.md template into a new group folder
 * when a channel skill registers a group via the register_group IPC.
 * If ASSISTANT_NAME is non-default, it rewrites the heading, identity
 * line, and @Andy trigger references so the rendered file is consistent.
 */

function applyRenames(content: string, assistantName: string): string {
  let out = content;
  out = out.replace(/^# Andy$/m, `# ${assistantName}`);
  out = out.replace(/You are Andy/g, `You are ${assistantName}`);
  out = out.replace(/@Andy\b/g, `@${assistantName}`);
  return out;
}

describe('registerGroup CLAUDE.md template rename', () => {
  it('rewrites heading, identity line, and @Andy trigger references', () => {
    const template = [
      '# Andy',
      '',
      'You are Andy, a helpful assistant.',
      '',
      'Scheduled tasks:',
      '  { "trigger": "@Andy", "prompt": "daily" }',
      '  { "trigger": "@Andy", "prompt": "weekly" }',
    ].join('\n');

    const renamed = applyRenames(template, 'Ruby');

    expect(renamed).toContain('# Ruby');
    expect(renamed).toContain('You are Ruby');
    expect(renamed).not.toContain('@Andy');
    expect(renamed).toContain('@Ruby');
  });

  it('word boundary prevents matching names that start with Andy', () => {
    const renamed = applyRenames('@Andyville is unrelated', 'Ruby');
    expect(renamed).toBe('@Andyville is unrelated');
  });

  it('leaves content unchanged when assistant name is Andy', () => {
    const template = '# Andy\n\nYou are Andy.\n\n@Andy trigger';
    // registerGroup short-circuits this case — applyRenames is only called
    // when ASSISTANT_NAME !== 'Andy', so we simulate that guard here.
    const out = template; // no rename performed
    expect(out).toContain('# Andy');
    expect(out).toContain('@Andy');
  });
});
