import { describe, expect, it } from 'vitest';

import { rewriteAssistantNameInClaudeMd } from './register.js';

describe('rewriteAssistantNameInClaudeMd', () => {
  it('rewrites current default assistant literals', () => {
    const source = '# Dobby\n\nYou are Dobby. Help the user.\n';
    const result = rewriteAssistantNameInClaudeMd(source, 'Nora');

    expect(result).toContain('# Nora');
    expect(result).toContain('You are Nora. Help the user.');
  });

  it('rewrites legacy Andy literals for backward compatibility', () => {
    const source = '# Andy\n\nYou are Andy. Help the user.\n';
    const result = rewriteAssistantNameInClaudeMd(source, 'Nora');

    expect(result).toContain('# Nora');
    expect(result).toContain('You are Nora. Help the user.');
  });

  it('does not modify files without default assistant literals', () => {
    const source = '# Custom Agent\n\nYou are Custom Agent.\n';
    const result = rewriteAssistantNameInClaudeMd(source, 'Nora');

    expect(result).toBe(source);
  });
});
