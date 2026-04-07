import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

const distDir = path.resolve(import.meta.dirname, '..', 'dist');
const repoRoot = path.resolve(distDir, '..');

describe('package exports', () => {
  // --- ESM exports ---

  describe('ESM', () => {
    it('exports createAgentLite from root', async () => {
      const sdkPath = path.resolve(distDir, 'api', 'sdk.js');
      const mod = await import(sdkPath);
      expect(mod.createAgentLite).toBeDefined();
      expect(typeof mod.createAgentLite).toBe('function');
    });

    it('exports telegram factory from channels/telegram', async () => {
      const telegramPath = path.resolve(
        distDir,
        'api',
        'channels',
        'telegram.js',
      );
      const mod = await import(telegramPath);
      expect(mod.telegram).toBeDefined();
      expect(typeof mod.telegram).toBe('function');
    });

    it('telegram() returns a ChannelDriverFactory function', async () => {
      const telegramPath = path.resolve(
        distDir,
        'api',
        'channels',
        'telegram.js',
      );
      const mod = await import(telegramPath);
      const factory = mod.telegram({ token: 'test-token' });
      expect(typeof factory).toBe('function');
    });
  });

  // --- CJS exports ---

  describe('CJS', () => {
    it('dist/api/sdk.cjs exists', () => {
      expect(existsSync(path.join(distDir, 'api', 'sdk.cjs'))).toBe(true);
    });

    it('dist/api/channels/telegram.cjs exists', () => {
      expect(
        existsSync(path.join(distDir, 'api', 'channels', 'telegram.cjs')),
      ).toBe(true);
    });

    it('sdk.cjs exports createAgentLite via require()', () => {
      const result = execFileSync(
        'node',
        [
          '-e',
          'const m = require("./dist/api/sdk.cjs"); console.log(JSON.stringify(Object.keys(m)))',
        ],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      const keys = JSON.parse(result.trim());
      expect(keys).toContain('createAgentLite');
    });

    it('channels/telegram.cjs exports telegram factory via require()', () => {
      const result = execFileSync(
        'node',
        [
          '-e',
          'const m = require("./dist/api/channels/telegram.cjs"); console.log(JSON.stringify(Object.keys(m)))',
        ],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      const keys = JSON.parse(result.trim());
      expect(keys).toContain('telegram');
    });

    it('CJS telegram() returns a factory function', () => {
      const result = execFileSync(
        'node',
        [
          '-e',
          'const { telegram } = require("./dist/api/channels/telegram.cjs"); const f = telegram({ token: "test" }); console.log(typeof f)',
        ],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      expect(result.trim()).toBe('function');
    });
  });
});
