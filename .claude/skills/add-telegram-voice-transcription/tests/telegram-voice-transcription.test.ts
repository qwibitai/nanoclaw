import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('add-telegram-voice-transcription skill', () => {
  describe('SKILL.md', () => {
    it('exists', () => {
      expect(fs.existsSync(path.join(SKILL_DIR, 'SKILL.md'))).toBe(true);
    });

    it('has correct frontmatter', () => {
      const content = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
      expect(content).toMatch(/^---/);
      expect(content).toContain('name: add-telegram-voice-transcription');
      expect(content).toContain('description:');
    });
  });

  describe('manifest.yaml', () => {
    it('exists', () => {
      expect(fs.existsSync(path.join(SKILL_DIR, 'manifest.yaml'))).toBe(true);
    });

    it('has correct skill name', () => {
      const content = fs.readFileSync(path.join(SKILL_DIR, 'manifest.yaml'), 'utf8');
      expect(content).toContain('skill: add-telegram-voice-transcription');
    });

    it('lists telegram.ts as modified', () => {
      const content = fs.readFileSync(path.join(SKILL_DIR, 'manifest.yaml'), 'utf8');
      expect(content).toContain('src/channels/telegram.ts');
    });

    it('lists TRANSCRIPTION_URL as env addition', () => {
      const content = fs.readFileSync(path.join(SKILL_DIR, 'manifest.yaml'), 'utf8');
      expect(content).toContain('TRANSCRIPTION_URL');
    });

    it('depends on add-telegram', () => {
      const content = fs.readFileSync(path.join(SKILL_DIR, 'manifest.yaml'), 'utf8');
      expect(content).toContain('add-telegram');
    });
  });

  describe('modify/src/channels/telegram.ts', () => {
    const modifiedPath = path.join(SKILL_DIR, 'modify', 'src', 'channels', 'telegram.ts');

    it('exists', () => {
      expect(fs.existsSync(modifiedPath)).toBe(true);
    });

    const content = fs.readFileSync(
      path.join(SKILL_DIR, 'modify', 'src', 'channels', 'telegram.ts'),
      'utf8',
    );

    it('contains TRANSCRIPTION_URL constant', () => {
      expect(content).toContain('const TRANSCRIPTION_URL');
      expect(content).toContain("process.env.TRANSCRIPTION_URL || 'http://localhost:8765'");
    });

    it('contains transcribeVoice function', () => {
      expect(content).toContain('async function transcribeVoice(');
      expect(content).toContain('fileBuffer: Buffer');
      expect(content).toContain('/api/transcribe-sync');
    });

    it('contains voice handler with transcription logic', () => {
      expect(content).toContain("this.bot.on('message:voice', async (ctx)");
      expect(content).toContain('await transcribeVoice(buffer');
      expect(content).toContain('[Voice message]:');
      expect(content).toContain('transcription unavailable');
    });

    it('contains health check logic', () => {
      expect(content).toContain('Transcription service is reachable');
      expect(content).toContain(`\${TRANSCRIPTION_URL}/health`);
      expect(content).toContain('AbortSignal.timeout(3000)');
    });

    it('preserves message:text handler', () => {
      expect(content).toContain("this.bot.on('message:text'");
    });

    it('preserves message:photo handler', () => {
      expect(content).toContain("this.bot.on('message:photo'");
    });

    it('preserves message:video handler', () => {
      expect(content).toContain("this.bot.on('message:video'");
    });

    it('preserves message:audio handler', () => {
      expect(content).toContain("this.bot.on('message:audio'");
    });

    it('preserves message:document handler', () => {
      expect(content).toContain("this.bot.on('message:document'");
    });

    it('preserves message:sticker handler', () => {
      expect(content).toContain("this.bot.on('message:sticker'");
    });

    it('preserves message:location handler', () => {
      expect(content).toContain("this.bot.on('message:location'");
    });

    it('preserves message:contact handler', () => {
      expect(content).toContain("this.bot.on('message:contact'");
    });

    it('preserves storeNonText helper', () => {
      expect(content).toContain('const storeNonText');
    });

    it('preserves sendTelegramMessage function', () => {
      expect(content).toContain('async function sendTelegramMessage(');
    });

    it('preserves registerChannel call', () => {
      expect(content).toContain("registerChannel('telegram'");
    });
  });

  describe('intent file', () => {
    it('exists for modified telegram.ts', () => {
      expect(
        fs.existsSync(
          path.join(SKILL_DIR, 'modify', 'src', 'channels', 'telegram.ts.intent.md'),
        ),
      ).toBe(true);
    });
  });
});
