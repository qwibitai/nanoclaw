import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  encryptProfile,
  decryptProfile,
  generateEncryptionKey,
  encryptSingleFile,
  decryptSingleFile,
} from './profile-crypto.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-crypto-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('profile-crypto', () => {
  const tempDirs: string[] = [];

  function trackDir(dir: string): string {
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmrf(dir);
    }
    tempDirs.length = 0;
  });

  describe('generateEncryptionKey', () => {
    it('returns a 32-byte buffer', () => {
      const key = generateEncryptionKey();
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('returns unique keys', () => {
      const a = generateEncryptionKey();
      const b = generateEncryptionKey();
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('encryptProfile + decryptProfile', () => {
    it('round-trips a single file', () => {
      const dir = trackDir(makeTempDir());
      const content = 'hello browser profile';
      fs.writeFileSync(path.join(dir, 'cookies.db'), content);

      const key = generateEncryptionKey();
      encryptProfile(dir, key);

      // File should be different from original
      const encrypted = fs.readFileSync(path.join(dir, 'cookies.db'));
      expect(encrypted.toString()).not.toBe(content);

      // Decrypt to temp dir
      const decryptedDir = trackDir(decryptProfile(dir, key));
      const restored = fs.readFileSync(
        path.join(decryptedDir, 'cookies.db'),
        'utf-8',
      );
      expect(restored).toBe(content);
    });

    it('round-trips nested directories', () => {
      const dir = trackDir(makeTempDir());
      fs.mkdirSync(path.join(dir, 'Default', 'Storage'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), '{"a":1}');
      fs.writeFileSync(
        path.join(dir, 'Default', 'Storage', 'data.db'),
        'binary-ish',
      );

      const key = generateEncryptionKey();
      encryptProfile(dir, key);

      const decryptedDir = trackDir(decryptProfile(dir, key));
      expect(
        fs.readFileSync(
          path.join(decryptedDir, 'Default', 'Preferences'),
          'utf-8',
        ),
      ).toBe('{"a":1}');
      expect(
        fs.readFileSync(
          path.join(decryptedDir, 'Default', 'Storage', 'data.db'),
          'utf-8',
        ),
      ).toBe('binary-ish');
    });

    it('fails with wrong key', () => {
      const dir = trackDir(makeTempDir());
      fs.writeFileSync(path.join(dir, 'secret.txt'), 'top secret');

      const key = generateEncryptionKey();
      encryptProfile(dir, key);

      const wrongKey = generateEncryptionKey();
      expect(() => decryptProfile(dir, wrongKey)).toThrow();
    });

    it('handles empty directory', () => {
      const dir = trackDir(makeTempDir());
      const key = generateEncryptionKey();

      // Should not throw on empty directory
      encryptProfile(dir, key);
      const decryptedDir = trackDir(decryptProfile(dir, key));
      expect(fs.readdirSync(decryptedDir)).toEqual([]);
    });

    it('handles binary content', () => {
      const dir = trackDir(makeTempDir());
      const binary = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01, 0xfe]);
      fs.writeFileSync(path.join(dir, 'binary.dat'), binary);

      const key = generateEncryptionKey();
      encryptProfile(dir, key);

      const decryptedDir = trackDir(decryptProfile(dir, key));
      const restored = fs.readFileSync(path.join(decryptedDir, 'binary.dat'));
      expect(restored.equals(binary)).toBe(true);
    });
  });

  describe('error cases', () => {
    it('throws for non-existent profile dir on encrypt', () => {
      const key = generateEncryptionKey();
      expect(() => encryptProfile('/no/such/dir', key)).toThrow(
        'does not exist',
      );
    });

    it('throws for non-existent profile dir on decrypt', () => {
      const key = generateEncryptionKey();
      expect(() => decryptProfile('/no/such/dir', key)).toThrow(
        'does not exist',
      );
    });
  });

  describe('single-file operations', () => {
    let tmpDir: string;
    let key: Buffer;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'nanoclaw-crypto-single-'),
      );
      key = generateEncryptionKey();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('encrypts and decrypts a single file', () => {
      const filePath = path.join(tmpDir, 'state.json');
      const original = JSON.stringify({
        cookies: [{ name: 'auth', value: 'abc' }],
      });
      fs.writeFileSync(filePath, original);

      encryptSingleFile(filePath, key);
      const encrypted = fs.readFileSync(filePath);
      expect(encrypted.toString()).not.toBe(original);

      const decrypted = decryptSingleFile(filePath, key);
      expect(decrypted.toString()).toBe(original);
    });

    it('throws on corrupted encrypted file', () => {
      const filePath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(filePath, 'not encrypted data that is too short');

      expect(() => decryptSingleFile(filePath, key)).toThrow();
    });

    it('roundtrips JSON storage state', () => {
      const filePath = path.join(tmpDir, 'state.json');
      const state = {
        cookies: [{ name: 'session', value: 'xyz', domain: '.example.com' }],
        origins: [
          {
            origin: 'https://example.com',
            localStorage: [{ name: 'key', value: 'val' }],
          },
        ],
      };
      fs.writeFileSync(filePath, JSON.stringify(state));

      encryptSingleFile(filePath, key);
      const decrypted = decryptSingleFile(filePath, key);
      const restored = JSON.parse(decrypted.toString());

      expect(restored).toEqual(state);
    });
  });
});
