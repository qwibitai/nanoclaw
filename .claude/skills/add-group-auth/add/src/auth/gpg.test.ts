import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Keep path short to stay under Unix socket limit (107 chars for S.gpg-agent.browser)
const tmpDir = path.join(os.tmpdir(), `nc-gpg-${process.pid}`);
vi.stubEnv('HOME', tmpDir);

beforeEach(() => {
  fs.mkdirSync(path.join(tmpDir, '.config', 'nanoclaw'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const {
  isGpgAvailable,
  ensureGpgKey,
  exportPublicKey,
  gpgDecrypt,
  isPgpMessage,
} = await import('./gpg.js');

describe('isPgpMessage', () => {
  it('detects PGP message header', () => {
    expect(isPgpMessage('-----BEGIN PGP MESSAGE-----\nabc\n-----END PGP MESSAGE-----')).toBe(true);
  });

  it('detects PGP header with surrounding text', () => {
    expect(isPgpMessage('here is the encrypted key:\n-----BEGIN PGP MESSAGE-----\nabc')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(isPgpMessage('sk-ant-api03-test')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isPgpMessage('')).toBe(false);
  });

  it('returns false for other PGP blocks', () => {
    expect(isPgpMessage('-----BEGIN PGP PUBLIC KEY BLOCK-----')).toBe(false);
  });
});

// GPG integration tests — only run if gpg is available
const gpgAvailable = isGpgAvailable();

describe.skipIf(!gpgAvailable)('GPG integration', () => {
  it('isGpgAvailable returns true', () => {
    expect(isGpgAvailable()).toBe(true);
  });

  it('ensureGpgKey creates a keypair', () => {
    ensureGpgKey('gpg-test-scope');

    const gnupgDir = path.join(tmpDir, '.config', 'nanoclaw', 'credentials', 'gpg-test-scope', '.gnupg');
    expect(fs.existsSync(gnupgDir)).toBe(true);
  });

  it('ensureGpgKey is idempotent', () => {
    ensureGpgKey('gpg-idem-scope');
    ensureGpgKey('gpg-idem-scope');
    // No error on second call
  });

  it('exportPublicKey returns ASCII-armored key', () => {
    ensureGpgKey('gpg-export-scope');
    const pubKey = exportPublicKey('gpg-export-scope');
    expect(pubKey).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----');
    expect(pubKey).toContain('-----END PGP PUBLIC KEY BLOCK-----');
  });

  it('encrypt and decrypt round-trip', () => {
    const scope = 'gpg-roundtrip';
    ensureGpgKey(scope);
    const pubKey = exportPublicKey(scope);

    // Import the public key into a separate temp gpg homedir to simulate user side
    const userGpgHome = path.join(tmpDir, 'user-gpg');
    fs.mkdirSync(userGpgHome, { mode: 0o700, recursive: true });

    execFileSync('gpg', [
      '--homedir', userGpgHome,
      '--batch',
      '--import',
    ], { input: pubKey, stdio: ['pipe', 'pipe', 'pipe'] });

    // Encrypt as the user would
    const plaintext = 'sk-ant-api03-my-secret-key';
    const encrypted = execFileSync('gpg', [
      '--homedir', userGpgHome,
      '--batch',
      '--trust-model', 'always',
      '--encrypt',
      '--armor',
      '--recipient', 'nanoclaw',
    ], { input: plaintext, stdio: ['pipe', 'pipe', 'pipe'] }).toString('utf-8');

    expect(encrypted).toContain('-----BEGIN PGP MESSAGE-----');

    // Decrypt on the server side
    const decrypted = gpgDecrypt(scope, encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('gpgDecrypt throws on invalid ciphertext', () => {
    const scope = 'gpg-bad-decrypt';
    ensureGpgKey(scope);

    expect(() => gpgDecrypt(scope, '-----BEGIN PGP MESSAGE-----\ninvalid\n-----END PGP MESSAGE-----'))
      .toThrow();
  });

  it('different scopes have independent keys', () => {
    ensureGpgKey('scope-a');
    ensureGpgKey('scope-b');

    const keyA = exportPublicKey('scope-a');
    const keyB = exportPublicKey('scope-b');

    // Keys should be different (different keypairs)
    expect(keyA).not.toBe(keyB);
  });
});
