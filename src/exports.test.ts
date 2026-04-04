import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

const distDir = path.resolve(import.meta.dirname, '..', 'dist');
const repoRoot = path.resolve(distDir, '..');

describe('package exports', () => {
  // --- ESM exports ---

  describe('ESM', () => {
    it('exports AgentLite from root', async () => {
      const sdkPath = path.resolve(distDir, 'sdk.js');
      const mod = await import(sdkPath);
      expect(mod.AgentLite).toBeDefined();
      expect(typeof mod.AgentLite).toBe('function');
    });

    it('exports TelegramChannel from channels/telegram', async () => {
      const telegramPath = path.resolve(distDir, 'channels', 'telegram.js');
      const mod = await import(telegramPath);
      expect(mod.TelegramChannel).toBeDefined();
      expect(typeof mod.TelegramChannel).toBe('function');
    });

    it('TelegramChannel accepts positional args', async () => {
      const telegramPath = path.resolve(distDir, 'channels', 'telegram.js');
      const mod = await import(telegramPath);
      const noopOpts = { onMessage: () => {}, onChatMetadata: () => {}, registeredGroups: () => ({}) };
      const channel = new mod.TelegramChannel('test', noopOpts);
      expect(channel.name).toBe('telegram');
    });
  });

  // --- CJS exports ---

  describe('CJS', () => {
    it('dist/sdk.cjs exists', () => {
      expect(existsSync(path.join(distDir, 'sdk.cjs'))).toBe(true);
    });

    it('dist/channels/telegram.cjs exists', () => {
      expect(existsSync(path.join(distDir, 'channels', 'telegram.cjs'))).toBe(
        true,
      );
    });

    it('sdk.cjs exports AgentLite via require()', () => {
      const result = execFileSync(
        'node',
        [
          '-e',
          'const m = require("./dist/sdk.cjs"); console.log(JSON.stringify(Object.keys(m)))',
        ],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      const keys = JSON.parse(result.trim());
      expect(keys).toContain('AgentLite');
    });

    it('channels/telegram.cjs exports TelegramChannel via require()', () => {
      const result = execFileSync(
        'node',
        [
          '-e',
          'const m = require("./dist/channels/telegram.cjs"); console.log(JSON.stringify(Object.keys(m)))',
        ],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      const keys = JSON.parse(result.trim());
      expect(keys).toContain('TelegramChannel');
    });

    it('CJS TelegramChannel accepts positional args', () => {
      const result = execFileSync(
        'node',
        [
          '-e',
          'const { TelegramChannel } = require("./dist/channels/telegram.cjs"); const opts = { onMessage(){}, onChatMetadata(){}, registeredGroups(){ return {} } }; const ch = new TelegramChannel("test", opts); console.log(ch.name)',
        ],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      expect(result.trim()).toBe('telegram');
    });
  });
});
