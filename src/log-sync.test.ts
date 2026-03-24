import { describe, expect, it } from 'vitest';
import { buildSyncCommand, buildTempDir, parseFindOutput } from './log-sync.js';

describe('buildSyncCommand', () => {
  it('builds find command for today-only logs', () => {
    const cmd = buildSyncCommand(
      'alice',
      '100.84.112.81',
      '/var/log/api/',
      '*.log',
    );
    expect(cmd).toContain('ssh');
    expect(cmd).toContain('alice@100.84.112.81');
    expect(cmd).toContain('find');
    expect(cmd).toContain('/var/log/api/');
    expect(cmd).toContain('-name');
    expect(cmd).toContain('*.log');
    expect(cmd).toContain('-newermt');
    expect(cmd).toContain('today 00:00');
  });

  it('rejects invalid username', () => {
    expect(() =>
      buildSyncCommand('alice;rm -rf', '10.0.0.1', '/var/log/', '*.log'),
    ).toThrow('Invalid username');
  });

  it('rejects invalid host', () => {
    expect(() =>
      buildSyncCommand('alice', 'host;evil', '/var/log/', '*.log'),
    ).toThrow('Invalid host');
  });

  it('rejects logPath with injection characters', () => {
    expect(() =>
      buildSyncCommand('alice', '10.0.0.1', "/var/log';rm -rf /", '*.log'),
    ).toThrow('Invalid logPath');
  });
});

describe('parseFindOutput', () => {
  it('splits find output into file paths', () => {
    const output = '/var/log/api/app.log\n/var/log/api/error.log\n';
    const files = parseFindOutput(output);
    expect(files).toEqual(['/var/log/api/app.log', '/var/log/api/error.log']);
  });

  it('handles empty output', () => {
    expect(parseFindOutput('')).toEqual([]);
    expect(parseFindOutput('\n')).toEqual([]);
  });
});

describe('buildTempDir', () => {
  it('creates deterministic temp path from profile and source', () => {
    const dir = buildTempDir('prof-1', 'prod-api');
    expect(dir).toBe('/tmp/nanoclaw-logs/prof-1/prod-api');
  });
});
