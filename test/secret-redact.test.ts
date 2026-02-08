import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

// Dynamic import after mocks are set up
let loadSecrets: typeof import('../src/secret-redact.js').loadSecrets;
let redactSecrets: typeof import('../src/secret-redact.js').redactSecrets;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-redact-test-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  // Re-import to get fresh module state
  vi.resetModules();
  const mod = await import('../src/secret-redact.js');
  loadSecrets = mod.loadSecrets;
  redactSecrets = mod.redactSecrets;
});

afterEach(() => {
  cwdSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeEnv(content: string): void {
  fs.writeFileSync(path.join(tmpDir, '.env'), content);
}

describe('loadSecrets + redactSecrets', () => {
  it('redacts ANTHROPIC_API_KEY from output', () => {
    writeEnv('ANTHROPIC_API_KEY=sk-ant-secret-key-12345678');
    loadSecrets();

    const input = 'Here is the key: sk-ant-secret-key-12345678';
    expect(redactSecrets(input)).toBe('Here is the key: [REDACTED]');
  });

  it('redacts CLAUDE_CODE_OAUTH_TOKEN from output', () => {
    writeEnv('CLAUDE_CODE_OAUTH_TOKEN=oauth-token-abcdef99');
    loadSecrets();

    expect(redactSecrets('token=oauth-token-abcdef99')).toBe(
      'token=[REDACTED]',
    );
  });

  it('redacts multiple secrets in the same string', () => {
    writeEnv(
      'ANTHROPIC_API_KEY=sk-ant-aaaa\nCLAUDE_CODE_OAUTH_TOKEN=oauth-bbbb-cccc',
    );
    loadSecrets();

    const input = 'key=sk-ant-aaaa and token=oauth-bbbb-cccc end';
    expect(redactSecrets(input)).toBe(
      'key=[REDACTED] and token=[REDACTED] end',
    );
  });

  it('redacts all occurrences of the same secret', () => {
    writeEnv('ANTHROPIC_API_KEY=sk-ant-repeated-key');
    loadSecrets();

    const input = 'first: sk-ant-repeated-key, second: sk-ant-repeated-key';
    expect(redactSecrets(input)).toBe('first: [REDACTED], second: [REDACTED]');
  });

  it('handles double-quoted values in .env', () => {
    writeEnv('ANTHROPIC_API_KEY="sk-ant-quoted-value"');
    loadSecrets();

    expect(redactSecrets('key is sk-ant-quoted-value here')).toBe(
      'key is [REDACTED] here',
    );
  });

  it('handles single-quoted values in .env', () => {
    writeEnv("ANTHROPIC_API_KEY='sk-ant-single-quoted'");
    loadSecrets();

    expect(redactSecrets('sk-ant-single-quoted')).toBe('[REDACTED]');
  });

  it('ignores non-allowlisted env vars', () => {
    writeEnv(
      'DATABASE_URL=postgres://secret\nANTHROPIC_API_KEY=sk-ant-real-key',
    );
    loadSecrets();

    // DATABASE_URL value should NOT be redacted
    expect(redactSecrets('postgres://secret')).toBe('postgres://secret');
    // ANTHROPIC_API_KEY value should be redacted
    expect(redactSecrets('sk-ant-real-key')).toBe('[REDACTED]');
  });

  it('ignores comments in .env', () => {
    writeEnv('# ANTHROPIC_API_KEY=sk-ant-commented-out\nANTHROPIC_API_KEY=sk-ant-actual');
    loadSecrets();

    // Commented-out value should NOT be redacted
    expect(redactSecrets('sk-ant-commented-out')).toBe('sk-ant-commented-out');
    expect(redactSecrets('sk-ant-actual')).toBe('[REDACTED]');
  });

  it('ignores values shorter than minimum length', () => {
    writeEnv('ANTHROPIC_API_KEY=short');
    loadSecrets();

    // "short" is < 8 chars, should not be redacted (too risky for false positives)
    expect(redactSecrets('short')).toBe('short');
  });

  it('returns text unchanged when no .env exists', () => {
    // Don't write any .env file
    loadSecrets();
    expect(redactSecrets('sk-ant-anything')).toBe('sk-ant-anything');
  });

  it('returns text unchanged when .env has no allowlisted vars', () => {
    writeEnv('DATABASE_URL=something\nREDIS_URL=else');
    loadSecrets();

    expect(redactSecrets('something else')).toBe('something else');
  });

  it('handles empty lines and whitespace in .env', () => {
    writeEnv('\n  \n\nANTHROPIC_API_KEY=sk-ant-spaced-key\n\n');
    loadSecrets();

    expect(redactSecrets('sk-ant-spaced-key')).toBe('[REDACTED]');
  });

  it('redacts secrets that appear in multiline output (env dump)', () => {
    writeEnv('ANTHROPIC_API_KEY=sk-ant-multiline-test');
    loadSecrets();

    const envDump = [
      'HOME=/home/node',
      'PATH=/usr/bin:/bin',
      'ANTHROPIC_API_KEY=sk-ant-multiline-test',
      'NODE_VERSION=20.0.0',
    ].join('\n');

    expect(redactSecrets(envDump)).toBe(
      [
        'HOME=/home/node',
        'PATH=/usr/bin:/bin',
        'ANTHROPIC_API_KEY=[REDACTED]',
        'NODE_VERSION=20.0.0',
      ].join('\n'),
    );
  });

  it('handles secrets containing regex-special characters', () => {
    writeEnv('ANTHROPIC_API_KEY=sk-ant-key+with.special$chars');
    loadSecrets();

    expect(redactSecrets('found sk-ant-key+with.special$chars here')).toBe(
      'found [REDACTED] here',
    );
  });
});
