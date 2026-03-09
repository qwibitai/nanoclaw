import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('add-discord-image-vision skill package', () => {
  // --- Manifest ---

  describe('manifest', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(path.join(SKILL_DIR, 'manifest.yaml'), 'utf-8');
    });

    it('has a valid manifest.yaml', () => {
      expect(fs.existsSync(path.join(SKILL_DIR, 'manifest.yaml'))).toBe(true);
      expect(content).toContain('skill: add-discord-image-vision');
      expect(content).toContain('version: 1.0.0');
    });

    it('declares no npm dependencies (uses built-in fetch + existing sharp)', () => {
      expect(content).toContain('npm_dependencies: {}');
    });

    it('has no env_additions', () => {
      expect(content).toContain('env_additions: []');
    });

    it('adds no new files', () => {
      expect(content).toContain('adds: []');
    });

    it('lists all modify files', () => {
      expect(content).toContain('src/channels/discord.ts');
      expect(content).toContain('src/channels/discord.test.ts');
    });

    it('declares add-image-vision and add-discord as dependencies', () => {
      expect(content).toContain('add-image-vision');
      expect(content).toContain('add-discord');
    });
  });

  // --- modify/ files exist ---

  describe('modify/ files exist', () => {
    const modifyFiles = [
      'src/channels/discord.ts',
      'src/channels/discord.test.ts',
    ];

    for (const file of modifyFiles) {
      it(`includes modify/${file}`, () => {
        const filePath = path.join(SKILL_DIR, 'modify', file);
        expect(fs.existsSync(filePath)).toBe(true);
      });
    }
  });

  // --- Intent files exist ---

  describe('intent files exist', () => {
    const intentFiles = [
      'src/channels/discord.ts.intent.md',
      'src/channels/discord.test.ts.intent.md',
    ];

    for (const file of intentFiles) {
      it(`includes modify/${file}`, () => {
        const filePath = path.join(SKILL_DIR, 'modify', file);
        expect(fs.existsSync(filePath)).toBe(true);
      });
    }
  });

  // --- modify/src/channels/discord.ts ---

  describe('modify/src/channels/discord.ts', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(
        path.join(SKILL_DIR, 'modify', 'src', 'channels', 'discord.ts'),
        'utf-8',
      );
    });

    it('imports path module', () => {
      expect(content).toContain("import path from 'path'");
    });

    it('imports GROUPS_DIR from config', () => {
      expect(content).toContain('GROUPS_DIR');
      expect(content).toContain("from '../config.js'");
    });

    it('imports processImage from image.js', () => {
      expect(content).toContain("import { processImage } from '../image.js'");
    });

    it('downloads image from Discord CDN via fetch', () => {
      expect(content).toContain('await fetch(att.url)');
      expect(content).toContain('await response.arrayBuffer()');
      expect(content).toContain('Buffer.from(');
    });

    it('calls processImage with buffer and groupDir', () => {
      expect(content).toContain('processImage(buffer, groupDir,');
    });

    it('builds groupDir from GROUPS_DIR and group.folder', () => {
      expect(content).toContain('path.join(GROUPS_DIR, group.folder)');
    });

    it('uses result.relativePath for processed image reference', () => {
      expect(content).toContain('[Image: ${result.relativePath}]');
    });

    it('falls back to filename placeholder on failure', () => {
      expect(content).toContain('Discord image - download failed');
      expect(content).toContain('[Image: ${att.name || \'image\'}]');
    });

    it('attachment handling is after registered-group guard', () => {
      const groupCheckIdx = content.indexOf('this.opts.registeredGroups()[chatJid]');
      const attachmentIdx = content.indexOf('message.attachments.size > 0');
      expect(groupCheckIdx).toBeGreaterThan(0);
      expect(attachmentIdx).toBeGreaterThan(groupCheckIdx);
    });

    it('skips empty messages with no content guard', () => {
      expect(content).toContain('if (!content) return;');
    });

    it('preserves core DiscordChannel structure', () => {
      expect(content).toContain('export class DiscordChannel implements Channel');
      expect(content).toContain('async connect()');
      expect(content).toContain('async sendMessage(');
      expect(content).toContain('isConnected()');
      expect(content).toContain('ownsJid(');
      expect(content).toContain('async disconnect()');
      expect(content).toContain('async setTyping(');
    });

    it('preserves non-image attachment placeholders', () => {
      expect(content).toContain('[Video: ${att.name || \'video\'}]');
      expect(content).toContain('[Audio: ${att.name || \'audio\'}]');
      expect(content).toContain('[File: ${att.name || \'file\'}]');
    });

    it('preserves registerChannel factory', () => {
      expect(content).toContain("registerChannel('discord'");
      expect(content).toContain('DISCORD_BOT_TOKEN');
    });
  });

  // --- modify/src/channels/discord.test.ts ---

  describe('modify/src/channels/discord.test.ts', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(
        path.join(SKILL_DIR, 'modify', 'src', 'channels', 'discord.test.ts'),
        'utf-8',
      );
    });

    it('mocks image.js module', () => {
      expect(content).toContain("vi.mock('../image.js'");
      expect(content).toContain('processImage');
    });

    it('mocks global fetch', () => {
      expect(content).toContain('vi.stubGlobal');
      expect(content).toContain('fetch');
    });

    it('mocks GROUPS_DIR in config', () => {
      expect(content).toContain('GROUPS_DIR');
    });

    it('includes image vision test cases', () => {
      expect(content).toContain('downloads and processes image attachments');
      expect(content).toContain('falls back to placeholder on image download failure');
      expect(content).toContain('falls back to placeholder when processImage returns null');
      expect(content).toContain('does not download images for unregistered channels');
    });

    it('preserves all existing test sections', () => {
      expect(content).toContain('connection lifecycle');
      expect(content).toContain('text message handling');
      expect(content).toContain('@mention translation');
      expect(content).toContain('reply context');
      expect(content).toContain('sendMessage');
      expect(content).toContain('ownsJid');
      expect(content).toContain('setTyping');
      expect(content).toContain('channel properties');
    });

    it('includes non-image attachment tests', () => {
      expect(content).toContain('stores video attachment with placeholder');
      expect(content).toContain('stores file attachment with placeholder');
    });
  });
});
