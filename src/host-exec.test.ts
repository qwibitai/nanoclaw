import { describe, it, expect } from 'vitest';

import { validateCommandArgs } from './host-exec.js';

describe('validateCommandArgs', () => {
  describe('git', () => {
    it('allows git pull', () => {
      expect(validateCommandArgs('git', ['pull'])).toBeNull();
    });

    it('allows git log', () => {
      expect(
        validateCommandArgs('git', ['log', '--oneline', '-10']),
      ).toBeNull();
    });

    it('allows git status', () => {
      expect(validateCommandArgs('git', ['status'])).toBeNull();
    });

    it('allows git diff', () => {
      expect(validateCommandArgs('git', ['diff', 'HEAD~1'])).toBeNull();
    });

    it('allows git pull with flags', () => {
      expect(validateCommandArgs('git', ['--no-pager', 'log'])).toBeNull();
    });

    it('blocks git push', () => {
      const result = validateCommandArgs('git', ['push', 'origin', 'main']);
      expect(result).toContain('not allowed');
      expect(result).toContain('push');
    });

    it('blocks git reset', () => {
      const result = validateCommandArgs('git', ['reset', '--hard', 'HEAD~1']);
      expect(result).toContain('not allowed');
      expect(result).toContain('reset');
    });

    it('blocks git checkout', () => {
      const result = validateCommandArgs('git', ['checkout', 'main']);
      expect(result).toContain('not allowed');
    });

    it('blocks git clean', () => {
      const result = validateCommandArgs('git', ['clean', '-fd']);
      expect(result).toContain('not allowed');
    });

    it('blocks --hard flag', () => {
      // Even if subcommand were somehow allowed, --hard is blocked
      expect(validateCommandArgs('git', ['pull', '--hard'])).toContain(
        '--hard',
      );
    });

    it('blocks --force flag', () => {
      expect(validateCommandArgs('git', ['pull', '--force'])).toContain(
        '--force',
      );
    });

    it('blocks -f flag', () => {
      expect(validateCommandArgs('git', ['pull', '-f'])).toContain('--force');
    });

    it('rejects git with no subcommand', () => {
      expect(validateCommandArgs('git', [])).toContain('requires a subcommand');
    });

    it('rejects git with only flags', () => {
      expect(validateCommandArgs('git', ['--no-pager'])).toContain(
        'requires a subcommand',
      );
    });
  });

  describe('npm', () => {
    it('allows npm install', () => {
      expect(validateCommandArgs('npm', ['install'])).toBeNull();
    });

    it('allows npm build', () => {
      expect(validateCommandArgs('npm', ['build'])).toBeNull();
    });

    it('allows npm ci', () => {
      expect(validateCommandArgs('npm', ['ci'])).toBeNull();
    });

    it('allows npm run', () => {
      expect(validateCommandArgs('npm', ['run', 'build'])).toBeNull();
    });

    it('allows npm install with flags', () => {
      expect(
        validateCommandArgs('npm', ['install', '--production']),
      ).toBeNull();
    });

    it('blocks npm publish', () => {
      const result = validateCommandArgs('npm', ['publish']);
      expect(result).toContain('not allowed');
      expect(result).toContain('publish');
    });

    it('blocks npm unpublish', () => {
      const result = validateCommandArgs('npm', ['unpublish']);
      expect(result).toContain('not allowed');
    });

    it('blocks npm adduser', () => {
      const result = validateCommandArgs('npm', ['adduser']);
      expect(result).toContain('not allowed');
    });

    it('rejects npm with no subcommand', () => {
      expect(validateCommandArgs('npm', [])).toContain('requires a subcommand');
    });
  });

  describe('other commands', () => {
    it('returns null for commands without arg restrictions', () => {
      expect(validateCommandArgs('cat', ['/etc/hostname'])).toBeNull();
      expect(validateCommandArgs('ls', ['-la'])).toBeNull();
      expect(validateCommandArgs('curl', ['https://example.com'])).toBeNull();
    });
  });
});
