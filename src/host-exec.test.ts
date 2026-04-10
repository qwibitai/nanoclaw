import { describe, it, expect } from 'vitest';

import { validateCommandArgs } from './host-exec.js';

describe('validateCommandArgs', () => {
  describe('systemctl', () => {
    it('allows systemctl status for other services', () => {
      expect(
        validateCommandArgs('systemctl', ['--user', 'status', 'agency-hq']),
      ).toBeNull();
    });

    it('allows systemctl restart for other services', () => {
      expect(
        validateCommandArgs('systemctl', ['--user', 'restart', 'agency-hq']),
      ).toBeNull();
    });

    it('blocks systemctl targeting nanoclaw by service name', () => {
      const result = validateCommandArgs('systemctl', [
        '--user',
        'stop',
        'nanoclaw',
      ]);
      expect(result).toContain('cannot target the nanoclaw service');
    });

    it('blocks systemctl targeting com.nanoclaw (launchd unit name)', () => {
      const result = validateCommandArgs('systemctl', [
        '--user',
        'restart',
        'com.nanoclaw',
      ]);
      expect(result).toContain('cannot target the nanoclaw service');
    });

    it('blocks systemctl targeting a nanoclaw variant', () => {
      const result = validateCommandArgs('systemctl', [
        '--user',
        'start',
        'nanoclaw.service',
      ]);
      expect(result).toContain('cannot target the nanoclaw service');
    });
  });

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

  describe('other commands', () => {
    it('returns null for commands without arg restrictions', () => {
      expect(validateCommandArgs('cat', ['/etc/hostname'])).toBeNull();
      expect(validateCommandArgs('ls', ['-la'])).toBeNull();
      expect(validateCommandArgs('curl', ['https://example.com'])).toBeNull();
      expect(validateCommandArgs('df', ['-h'])).toBeNull();
      expect(validateCommandArgs('free', ['-m'])).toBeNull();
      expect(validateCommandArgs('ps', ['aux'])).toBeNull();
      expect(validateCommandArgs('jq', ['.', '/tmp/data.json'])).toBeNull();
      expect(validateCommandArgs('node', ['--version'])).toBeNull();
      expect(
        validateCommandArgs('journalctl', [
          '--user',
          '-u',
          'agency-hq',
          '-n',
          '50',
        ]),
      ).toBeNull();
    });
  });
});
