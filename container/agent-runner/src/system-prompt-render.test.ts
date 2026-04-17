import { describe, expect, it } from 'vitest';

import { renderSystemPrompt } from './system-prompt.js';

describe('renderSystemPrompt', () => {
  it('replaces a single placeholder', () => {
    const result = renderSystemPrompt('Hello {{NAME}}!', { NAME: 'World' });
    expect(result).toBe('Hello World!');
  });

  it('replaces multiple placeholders', () => {
    const template = '{{SOUL}}\n---\n{{IDENTITY}}\n---\n{{VOICE}}';
    const result = renderSystemPrompt(template, {
      SOUL: 'soul content',
      IDENTITY: 'identity content',
      VOICE: 'voice content',
    });
    expect(result).toBe(
      'soul content\n---\nidentity content\n---\nvoice content',
    );
  });

  it('removes unfilled placeholders', () => {
    const result = renderSystemPrompt('A {{SOUL}} B {{MISSING}} C', {
      SOUL: 'x',
    });
    expect(result).toBe('A x B  C');
  });

  it('collapses consecutive blank lines (3+ → 2)', () => {
    const result = renderSystemPrompt('A\n\n\n\nB', {});
    expect(result).toBe('A\n\nB');
  });

  it('collapses empty separator sections (---\\n\\n---)', () => {
    const result = renderSystemPrompt(
      'Above\n\n---\n\n{{MISSING}}\n\n---\n\nBelow',
      {},
    );
    expect(result).toBe('Above\n\n---\n\nBelow');
  });

  it('handles empty replacements — removes all placeholders', () => {
    const template = '{{SOUL}}\n\n---\n\n{{IDENTITY}}';
    const result = renderSystemPrompt(template, {});
    expect(result).not.toContain('{{');
  });

  it('returns template as-is when no placeholders exist', () => {
    const template = 'Plain text with no placeholders.';
    const result = renderSystemPrompt(template, {});
    expect(result).toBe('Plain text with no placeholders.');
  });

  it('inserts multi-line content correctly', () => {
    const template = 'Before\n{{SOUL}}\nAfter';
    const multiLine = 'Line 1\nLine 2\nLine 3';
    const result = renderSystemPrompt(template, { SOUL: multiLine });
    expect(result).toBe('Before\nLine 1\nLine 2\nLine 3\nAfter');
  });
});
