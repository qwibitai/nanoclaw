import { describe, it, expect } from 'bun:test';

import { ClaudeProvider } from './claude.js';

describe('ClaudeProvider.errorSubstitutions', () => {
  const provider = new ClaudeProvider();
  const findRule = (name: string) => provider.errorSubstitutions.find((r) => r.name === name);

  describe('auth-required', () => {
    const rule = findRule('auth-required')!;

    it('exists', () => {
      expect(rule).toBeDefined();
    });

    it('matches the "Not logged in" banner', () => {
      expect(rule.test.test('Not logged in · Please run /login')).toBe(true);
    });

    it('matches the "Invalid API key" banner', () => {
      expect(rule.test.test('Invalid API key · Please run /login')).toBe(true);
    });

    it('matches with trailing content after the banner', () => {
      expect(rule.test.test('Not logged in · Please run /login\n\nstack trace …')).toBe(true);
    });

    it('does not match when the agent quotes the phrase mid-sentence', () => {
      const quoted = "The error 'Invalid API key · Please run /login' means your auth has expired.";
      expect(rule.test.test(quoted)).toBe(false);
    });

    it('does not match when the phrase is wrapped in quotes at the start', () => {
      const prose = '"Not logged in · Please run /login" is a Claude Code error.';
      expect(rule.test.test(prose)).toBe(false);
    });

    it('does not match a different separator', () => {
      expect(rule.test.test('Not logged in - Please run /login')).toBe(false);
    });

    it('replace text names the operator remediation', () => {
      expect(rule.replace).toContain('Anthropic credentials');
      expect(rule.replace).toContain('claude');
    });
  });
});
