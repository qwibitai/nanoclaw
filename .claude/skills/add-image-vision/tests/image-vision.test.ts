import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('add-image-vision skill package', () => {
  describe('manifest', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(path.join(SKILL_DIR, 'manifest.yaml'), 'utf-8');
    });

    it('has a valid manifest.yaml', () => {
      expect(fs.existsSync(path.join(SKILL_DIR, 'manifest.yaml'))).toBe(true);
      expect(content).toContain('skill: add-image-vision');
      expect(content).toContain('version: 1.0.0');
    });

    it('declares sharp as npm dependency', () => {
      expect(content).toContain('sharp:');
      expect(content).toMatch(/sharp:\s*"\^0\.34/);
    });

    it('has no env_additions', () => {
      expect(content).toContain('env_additions: []');
    });

    it('lists all add files', () => {
      expect(content).toContain('src/image.ts');
      expect(content).toContain('src/image.test.ts');
    });

    it('lists all modify files', () => {
      expect(content).toContain('src/channels/whatsapp.ts');
      expect(content).toContain('src/channels/whatsapp.test.ts');
      expect(content).toContain('src/container-runner.ts');
      expect(content).toContain('src/index.ts');
      expect(content).toContain('container/agent-runner/src/index.ts');
    });

    it('has no dependencies', () => {
      expect(content).toContain('depends: []');
    });
  });

  describe('add/ files', () => {
    it('includes src/image.ts with required exports', () => {
      const filePath = path.join(SKILL_DIR, 'add', 'src', 'image.ts');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('export function isImageMessage');
      expect(content).toContain('export async function processImage');
      expect(content).toContain('export function parseImageReferences');
      expect(content).toContain('export interface ProcessedImage');
      expect(content).toContain('export interface ImageAttachment');
      expect(content).toContain("import sharp from 'sharp'");
    });

    it('includes src/image.test.ts with test cases', () => {
      const filePath = path.join(SKILL_DIR, 'add', 'src', 'image.test.ts');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('isImageMessage');
      expect(content).toContain('processImage');
      expect(content).toContain('parseImageReferences');
    });
  });

  describe('modify/ files exist', () => {
    const modifyFiles = [
      'src/channels/whatsapp.ts',
      'src/channels/whatsapp.test.ts',
      'src/container-runner.ts',
      'src/index.ts',
      'container/agent-runner/src/index.ts',
    ];

    for (const file of modifyFiles) {
      it(`includes modify/${file}`, () => {
        const filePath = path.join(SKILL_DIR, 'modify', file);
        expect(fs.existsSync(filePath)).toBe(true);
      });
    }
  });

  describe('intent files exist', () => {
    const intentFiles = [
      'src/channels/whatsapp.ts.intent.md',
      'src/channels/whatsapp.test.ts.intent.md',
      'src/container-runner.ts.intent.md',
      'src/index.ts.intent.md',
      'container/agent-runner/src/index.ts.intent.md',
    ];

    for (const file of intentFiles) {
      it(`includes modify/${file}`, () => {
        const filePath = path.join(SKILL_DIR, 'modify', file);
        expect(fs.existsSync(filePath)).toBe(true);
      });
    }
  });

  describe('modify/src/channels/whatsapp.ts', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(
        path.join(SKILL_DIR, 'modify', 'src', 'channels', 'whatsapp.ts'),
        'utf-8',
      );
    });

    it('imports image utilities', () => {
      expect(content).toContain("import { isImageMessage, processImage } from '../image.js'");
    });

    it('imports downloadMediaMessage', () => {
      expect(content).toContain("import { downloadMediaMessage } from '@whiskeysockets/baileys'");
    });

    it('imports GROUPS_DIR from config', () => {
      expect(content).toContain('GROUPS_DIR');
    });

    it('uses let content for mutable assignment', () => {
      expect(content).toMatch(/let content\s*=/);
    });

    it('includes image processing block', () => {
      expect(content).toContain('isImageMessage(msg)');
      expect(content).toContain('processImage(buffer, groupDir, caption)');
      expect(content).toContain('[Image - download failed]');
      expect(content).toContain('[Image - processing failed]');
    });

    it('preserves core WhatsAppChannel structure', () => {
      expect(content).toContain('export class WhatsAppChannel implements Channel');
      expect(content).toContain('async connect()');
      expect(content).toContain('async sendMessage(');
      expect(content).toContain('async syncGroupMetadata(');
      expect(content).toContain('private async translateJid(');
      expect(content).toContain('private async flushOutgoingQueue(');
    });

    it('does NOT include voice transcription', () => {
      expect(content).not.toContain('isVoiceMessage');
      expect(content).not.toContain('transcribeAudioMessage');
      expect(content).not.toContain('transcription');
    });

    it('does NOT include PDF reader', () => {
      expect(content).not.toContain('documentMessage');
      expect(content).not.toContain('application/pdf');
    });

    it('does NOT include reconnection improvements', () => {
      expect(content).not.toContain('scheduleReconnect');
      expect(content).not.toContain('reconnectAttempts');
      expect(content).not.toContain('fetchLatestWaWebVersion');
    });
  });

  describe('modify/src/channels/whatsapp.test.ts', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(
        path.join(SKILL_DIR, 'modify', 'src', 'channels', 'whatsapp.test.ts'),
        'utf-8',
      );
    });

    it('mocks image.js module', () => {
      expect(content).toContain("vi.mock('../image.js'");
      expect(content).toContain('isImageMessage');
      expect(content).toContain('processImage');
    });

    it('mocks downloadMediaMessage', () => {
      expect(content).toContain('downloadMediaMessage');
    });

    it('includes image test cases', () => {
      expect(content).toContain('downloads and processes image attachments');
      expect(content).toContain('handles image without caption');
      expect(content).toContain('handles image download failure gracefully');
      expect(content).toContain('falls back to caption when processImage returns null');
    });

    it('preserves all existing test sections', () => {
      expect(content).toContain('connection lifecycle');
      expect(content).toContain('authentication');
      expect(content).toContain('reconnection');
      expect(content).toContain('message handling');
      expect(content).toContain('LID to JID translation');
      expect(content).toContain('outgoing message queue');
      expect(content).toContain('group metadata sync');
      expect(content).toContain('ownsJid');
      expect(content).toContain('setTyping');
      expect(content).toContain('channel properties');
    });

    it('does NOT include voice transcription tests', () => {
      expect(content).not.toContain('transcribes voice messages');
      expect(content).not.toContain('transcribeAudioMessage');
    });

    it('does NOT include PDF tests', () => {
      expect(content).not.toContain('downloads and injects PDF');
      expect(content).not.toContain('PDF download failure');
    });
  });

  describe('modify/src/container-runner.ts', () => {
    it('adds imageAttachments to ContainerInput', () => {
      const content = fs.readFileSync(
        path.join(SKILL_DIR, 'modify', 'src', 'container-runner.ts'),
        'utf-8',
      );
      expect(content).toContain('imageAttachments?');
      expect(content).toContain('relativePath: string');
      expect(content).toContain('mediaType: string');
    });

    it('does NOT include assistantName', () => {
      const content = fs.readFileSync(
        path.join(SKILL_DIR, 'modify', 'src', 'container-runner.ts'),
        'utf-8',
      );
      expect(content).not.toContain('assistantName');
    });
  });

  describe('modify/src/index.ts', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(
        path.join(SKILL_DIR, 'modify', 'src', 'index.ts'),
        'utf-8',
      );
    });

    it('imports parseImageReferences', () => {
      expect(content).toContain("import { parseImageReferences } from './image.js'");
    });

    it('calls parseImageReferences in processGroupMessages', () => {
      expect(content).toContain('parseImageReferences(missedMessages)');
    });

    it('passes imageAttachments to runAgent', () => {
      expect(content).toContain('imageAttachments');
      expect(content).toMatch(/runAgent\(group,\s*prompt,\s*chatJid,\s*imageAttachments/);
    });

    it('spreads imageAttachments into container input', () => {
      expect(content).toContain('...(imageAttachments.length > 0 && { imageAttachments })');
    });

    it('does NOT include resolveGroupFolderPath', () => {
      expect(content).not.toContain('resolveGroupFolderPath');
    });

    it('does NOT include assistantName in container input', () => {
      expect(content).not.toContain('assistantName');
    });
  });

  describe('modify/container/agent-runner/src/index.ts', () => {
    let content: string;

    beforeAll(() => {
      content = fs.readFileSync(
        path.join(SKILL_DIR, 'modify', 'container', 'agent-runner', 'src', 'index.ts'),
        'utf-8',
      );
    });

    it('defines ContentBlock types', () => {
      expect(content).toContain('interface ImageContentBlock');
      expect(content).toContain('interface TextContentBlock');
      expect(content).toContain('type ContentBlock = ImageContentBlock | TextContentBlock');
    });

    it('adds imageAttachments to ContainerInput', () => {
      expect(content).toContain('imageAttachments?');
    });

    it('adds pushMultimodal to MessageStream', () => {
      expect(content).toContain('pushMultimodal(content: ContentBlock[])');
    });

    it('includes image loading logic in runQuery', () => {
      expect(content).toContain('containerInput.imageAttachments');
      expect(content).toContain("path.join('/workspace/group', img.relativePath)");
      expect(content).toContain("toString('base64')");
      expect(content).toContain('stream.pushMultimodal(blocks)');
    });

    it('preserves core structure', () => {
      expect(content).toContain('async function runQuery');
      expect(content).toContain('class MessageStream');
      expect(content).toContain('function writeOutput');
      expect(content).toContain('function createPreCompactHook');
      expect(content).toContain('function createSanitizeBashHook');
      expect(content).toContain('async function main');
    });

    it('does NOT include assistantName', () => {
      expect(content).not.toContain('assistantName');
    });

    it('does NOT include Google/Vanta MCP', () => {
      expect(content).not.toContain('mcp__vanta__');
      expect(content).not.toContain('mcp__google-workspace__');
      expect(content).not.toContain('GOOGLE_OAUTH');
    });
  });
});
