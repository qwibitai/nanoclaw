import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Use a temp dir for all credential store operations
const tmpDir = path.join(os.tmpdir(), `nanoclaw-store-test-${Date.now()}`);
const keyPath = path.join(tmpDir, 'encryption-key');
const credsDir = path.join(tmpDir, 'credentials');

// Override HOME so the store uses our temp dir
vi.stubEnv('HOME', tmpDir);

// Mock config dir path by pointing HOME to tmpDir
// The store resolves ~/.config/nanoclaw/ from HOME
beforeEach(() => {
  // Create the config dir structure the store expects
  const configDir = path.join(tmpDir, '.config', 'nanoclaw');
  fs.mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Must import after env stub
const {
  initCredentialStore,
  hasCredential,
  loadCredential,
  saveCredential,
  deleteCredential,
  encrypt,
  decrypt,
} = await import('./store.js');

describe('CredentialStore', () => {
  beforeEach(() => {
    initCredentialStore();
  });

  describe('encryption', () => {
    it('encrypts and decrypts round-trip', () => {
      const plaintext = 'sk-ant-api03-secret-key-here';
      const encrypted = encrypt(plaintext);
      expect(encrypted).toMatch(/^enc:aes-256-gcm:/);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it('decrypt passes through plaintext', () => {
      expect(decrypt('not-encrypted')).toBe('not-encrypted');
    });

    it('each encryption produces different ciphertext (random IV)', () => {
      const plaintext = 'same-input';
      const a = encrypt(plaintext);
      const b = encrypt(plaintext);
      expect(a).not.toBe(b);
      expect(decrypt(a)).toBe(plaintext);
      expect(decrypt(b)).toBe(plaintext);
    });

    it('encrypted value contains key hash', () => {
      const encrypted = encrypt('test');
      const parts = encrypted.split(':');
      expect(parts).toHaveLength(6);
      expect(parts[0]).toBe('enc');
      expect(parts[1]).toBe('aes-256-gcm');
      expect(parts[2]).toHaveLength(16); // keyHash16
    });
  });

  describe('CRUD', () => {
    it('save and load round-trip', () => {
      saveCredential('test-scope', 'test-service', {
        auth_type: 'api_key',
        token: encrypt('my-secret'),
        expires_at: null,
        updated_at: new Date().toISOString(),
      });

      expect(hasCredential('test-scope', 'test-service')).toBe(true);

      const loaded = loadCredential('test-scope', 'test-service');
      expect(loaded).not.toBeNull();
      expect(loaded!.auth_type).toBe('api_key');
      expect(decrypt(loaded!.token)).toBe('my-secret');
    });

    it('hasCredential returns false for missing', () => {
      expect(hasCredential('nope', 'nope')).toBe(false);
    });

    it('loadCredential returns null for missing', () => {
      expect(loadCredential('nope', 'nope')).toBeNull();
    });

    it('deleteCredential removes the file', () => {
      saveCredential('del-scope', 'del-service', {
        auth_type: 'api_key',
        token: 'plain',
        expires_at: null,
        updated_at: new Date().toISOString(),
      });
      expect(hasCredential('del-scope', 'del-service')).toBe(true);

      deleteCredential('del-scope', 'del-service');
      expect(hasCredential('del-scope', 'del-service')).toBe(false);
    });

    it('deleteCredential is idempotent', () => {
      deleteCredential('nonexistent', 'nonexistent');
      // no throw
    });

    it('credentials are scoped — different scopes are independent', () => {
      saveCredential('scope-a', 'svc', {
        auth_type: 'api_key',
        token: encrypt('key-a'),
        expires_at: null,
        updated_at: new Date().toISOString(),
      });
      saveCredential('scope-b', 'svc', {
        auth_type: 'api_key',
        token: encrypt('key-b'),
        expires_at: null,
        updated_at: new Date().toISOString(),
      });

      const a = loadCredential('scope-a', 'svc');
      const b = loadCredential('scope-b', 'svc');
      expect(decrypt(a!.token)).toBe('key-a');
      expect(decrypt(b!.token)).toBe('key-b');
    });
  });

  describe('key generation', () => {
    it('creates encryption key on first init', () => {
      const configDir = path.join(tmpDir, '.config', 'nanoclaw');
      const keyFile = path.join(configDir, 'encryption-key');
      expect(fs.existsSync(keyFile)).toBe(true);
      const hex = fs.readFileSync(keyFile, 'utf-8').trim();
      expect(hex).toHaveLength(64); // 32 bytes = 64 hex chars
    });
  });
});
