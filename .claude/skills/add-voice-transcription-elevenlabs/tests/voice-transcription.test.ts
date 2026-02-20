import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('voice-transcription-elevenlabs skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: voice-transcription-elevenlabs');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('@elevenlabs/elevenlabs-js');
    expect(content).toContain('ELEVENLABS_API_KEY');
  });

  it('declares conflict with openai voice-transcription skill', () => {
    const content = fs.readFileSync(path.join(skillDir, 'manifest.yaml'), 'utf-8');
    expect(content).toContain('voice-transcription');
    expect(content).toMatch(/conflicts:\s*\n\s*-\s*voice-transcription/);
  });

  it('has all files declared in adds', () => {
    const transcriptionFile = path.join(skillDir, 'add', 'src', 'transcription.ts');
    expect(fs.existsSync(transcriptionFile)).toBe(true);

    const content = fs.readFileSync(transcriptionFile, 'utf-8');
    expect(content).toContain('transcribeAudioMessage');
    expect(content).toContain('isVoiceMessage');
    expect(content).toContain('transcribeWithElevenLabs');
    expect(content).toContain('downloadMediaMessage');
    expect(content).toContain('readEnvFile');
    expect(content).toContain('ElevenLabsClient');
    expect(content).toContain('scribe_v2');
  });

  it('has all files declared in modifies', () => {
    const whatsappFile = path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.ts');
    const whatsappTestFile = path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.test.ts');

    expect(fs.existsSync(whatsappFile)).toBe(true);
    expect(fs.existsSync(whatsappTestFile)).toBe(true);
  });

  it('has intent files for modified files', () => {
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.ts.intent.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.test.ts.intent.md'))).toBe(true);
  });

  it('modified whatsapp.ts preserves core structure', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.ts'),
      'utf-8',
    );

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
    expect(content).toContain('ASSISTANT_HAS_OWN_NUMBER');
    expect(content).toContain('ASSISTANT_NAME');
    expect(content).toContain('STORE_DIR');
  });

  it('modified whatsapp.ts includes transcription integration', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.ts'),
      'utf-8',
    );

    expect(content).toContain("import { isVoiceMessage, transcribeAudioMessage } from '../transcription.js'");
    expect(content).toContain('isVoiceMessage(msg)');
    expect(content).toContain('transcribeAudioMessage(msg, this.sock)');
    expect(content).toContain('finalContent');
    expect(content).toContain('[Voice:');
    expect(content).toContain('[Voice Message - transcription unavailable]');
    expect(content).toContain('[Voice Message - transcription failed]');
  });

  it('modified whatsapp.test.ts includes transcription mock and tests', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.test.ts'),
      'utf-8',
    );

    expect(content).toContain("vi.mock('../transcription.js'");
    expect(content).toContain('isVoiceMessage');
    expect(content).toContain('transcribeAudioMessage');
    expect(content).toContain('transcribes voice messages');
    expect(content).toContain('falls back when transcription returns null');
    expect(content).toContain('falls back when transcription throws');
    expect(content).toContain('[Voice: Hello this is a voice message]');
  });

  it('modified whatsapp.test.ts preserves all existing test sections', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.test.ts'),
      'utf-8',
    );

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
});
