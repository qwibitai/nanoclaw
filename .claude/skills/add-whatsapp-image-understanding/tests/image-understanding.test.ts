import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('add-whatsapp-image-understanding skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: add-whatsapp-image-understanding');
    expect(content).toContain('version: 1.0.0');
    // No npm dependencies or env additions needed
    expect(content).not.toContain('OPENAI_API_KEY');
  });

  it('has all files declared in adds', () => {
    const imageHandlerFile = path.join(skillDir, 'add', 'src', 'image-handler.ts');
    const imageCleanupFile = path.join(skillDir, 'add', 'src', 'image-cleanup.ts');

    expect(fs.existsSync(imageHandlerFile)).toBe(true);
    expect(fs.existsSync(imageCleanupFile)).toBe(true);

    const handlerContent = fs.readFileSync(imageHandlerFile, 'utf-8');
    expect(handlerContent).toContain('isImageMessage');
    expect(handlerContent).toContain('downloadImageMessage');
    expect(handlerContent).toContain('saveImageToGroup');
    expect(handlerContent).toContain('downloadMediaMessage');
    expect(handlerContent).toContain('normalizeMessageContent');

    const cleanupContent = fs.readFileSync(imageCleanupFile, 'utf-8');
    expect(cleanupContent).toContain('cleanupOldImages');
    expect(cleanupContent).toContain('startImageCleanup');
  });

  it('has all files declared in modifies', () => {
    const whatsappFile = path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.ts');
    const whatsappTestFile = path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.test.ts');
    const indexFile = path.join(skillDir, 'modify', 'src', 'index.ts');
    const claudeMdFile = path.join(skillDir, 'modify', 'groups', 'global', 'CLAUDE.md');

    expect(fs.existsSync(whatsappFile)).toBe(true);
    expect(fs.existsSync(whatsappTestFile)).toBe(true);
    expect(fs.existsSync(indexFile)).toBe(true);
    expect(fs.existsSync(claudeMdFile)).toBe(true);
  });

  it('has intent files for modified files', () => {
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.ts.intent.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.test.ts.intent.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'index.ts.intent.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'modify', 'groups', 'global', 'CLAUDE.md.intent.md'))).toBe(true);
  });

  it('modified whatsapp.ts preserves core structure', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.ts'),
      'utf-8',
    );

    // Core class and methods preserved
    expect(content).toContain('class WhatsAppChannel');
    expect(content).toContain('implements Channel');
    expect(content).toContain('async connect()');
    expect(content).toContain('async sendMessage(');
    expect(content).toContain('isConnected()');
    expect(content).toContain('ownsJid(');
    expect(content).toContain('async disconnect()');
    expect(content).toContain('async setTyping(');
    expect(content).toContain('async syncGroupMetadata(');
    expect(content).toContain('private async translateJid(');
    expect(content).toContain('private async flushOutgoingQueue(');

    // Core imports preserved
    expect(content).toContain('ASSISTANT_HAS_OWN_NUMBER');
    expect(content).toContain('ASSISTANT_NAME');
    expect(content).toContain('STORE_DIR');
  });

  it('modified whatsapp.ts includes image handling', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.ts'),
      'utf-8',
    );

    // Image handler imports
    expect(content).toContain("import { isImageMessage, downloadImageMessage, saveImageToGroup } from '../image-handler.js'");
    expect(content).toContain("import { isSenderAllowed, loadSenderAllowlist } from '../sender-allowlist.js'");

    // Image message handling
    expect(content).toContain('isImageMessage(msg)');
    expect(content).toContain('downloadImageMessage(msg, this.sock)');
    expect(content).toContain('saveImageToGroup(');
    expect(content).toContain('isSenderAllowed(');
    expect(content).toContain('[Image');
    expect(content).toContain('[Image - download failed]');
    expect(content).toContain('[Image from unauthorized sender]');

    // Content skip guard includes image check
    expect(content).toContain('!isImageMessage(msg)');
  });

  it('modified whatsapp.test.ts includes image mock and tests', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.test.ts'),
      'utf-8',
    );

    // Image handler mock
    expect(content).toContain("vi.mock('../image-handler.js'");
    expect(content).toContain('isImageMessage');
    expect(content).toContain('downloadImageMessage');
    expect(content).toContain('saveImageToGroup');

    // Sender allowlist mock
    expect(content).toContain("vi.mock('../sender-allowlist.js'");
    expect(content).toContain('isSenderAllowed');
    expect(content).toContain('loadSenderAllowlist');

    // Image test cases
    expect(content).toContain('downloads and saves image from allowed sender');
    expect(content).toContain('includes caption alongside image path');
    expect(content).toContain('blocks image download from non-allowed sender');
    expect(content).toContain('does not skip image without caption');
    expect(content).toContain('falls back gracefully when image download fails');
    expect(content).toContain('[Image — view it by reading: /workspace/group/images/test.jpg]');
  });

  it('modified whatsapp.test.ts preserves all existing test sections', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.test.ts'),
      'utf-8',
    );

    // All existing test describe blocks preserved
    expect(content).toContain("describe('connection lifecycle'");
    expect(content).toContain("describe('authentication'");
    expect(content).toContain("describe('reconnection'");
    expect(content).toContain("describe('message handling'");
    expect(content).toContain("describe('LID to JID translation'");
    expect(content).toContain("describe('outgoing message queue'");
    expect(content).toContain("describe('group metadata sync'");
    expect(content).toContain("describe('ownsJid'");
    expect(content).toContain("describe('setTyping'");
    expect(content).toContain("describe('channel properties'");
  });

  it('modified index.ts includes cleanup timer', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'index.ts'),
      'utf-8',
    );

    expect(content).toContain("import { startImageCleanup } from './image-cleanup.js'");
    expect(content).toContain('imageCleanupTimer');
    expect(content).toContain('startImageCleanup()');
    expect(content).toContain('clearInterval(imageCleanupTimer)');
  });

  it('modified global CLAUDE.md includes image instructions', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'groups', 'global', 'CLAUDE.md'),
      'utf-8',
    );

    expect(content).toContain('## Images');
    expect(content).toContain('view it by reading:');
    expect(content).toContain('Read');
    expect(content).toContain('[Image from unauthorized sender]');
  });
});
