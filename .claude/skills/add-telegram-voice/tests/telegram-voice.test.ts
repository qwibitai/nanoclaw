import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('add-telegram-voice skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: telegram-voice');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('src/transcription.ts');
    expect(content).toContain('src/channels/telegram.ts');
    expect(content).toContain('src/channels/telegram.test.ts');
  });

  it('declares telegram as a dependency', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'manifest.yaml'),
      'utf-8',
    );
    expect(content).toContain('depends:');
    expect(content).toContain('telegram');
  });

  it('declares conflict with voice-transcription', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'manifest.yaml'),
      'utf-8',
    );
    expect(content).toContain('conflicts:');
    expect(content).toContain('voice-transcription');
  });

  it('has no structured operations (no new npm deps needed)', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'manifest.yaml'),
      'utf-8',
    );
    expect(content).toContain('structured: {}');
  });

  it('has the added transcription file', () => {
    const filePath = path.join(skillDir, 'add', 'src', 'transcription.ts');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('has the modified telegram channel file', () => {
    const filePath = path.join(
      skillDir,
      'modify',
      'src',
      'channels',
      'telegram.ts',
    );
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('has the modified telegram test file', () => {
    const filePath = path.join(
      skillDir,
      'modify',
      'src',
      'channels',
      'telegram.test.ts',
    );
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('has intent files for modified files', () => {
    const tsIntent = path.join(
      skillDir,
      'modify',
      'src',
      'channels',
      'telegram.ts.intent.md',
    );
    const testIntent = path.join(
      skillDir,
      'modify',
      'src',
      'channels',
      'telegram.test.ts.intent.md',
    );
    expect(fs.existsSync(tsIntent)).toBe(true);
    expect(fs.existsSync(testIntent)).toBe(true);

    const tsContent = fs.readFileSync(tsIntent, 'utf-8');
    expect(tsContent).toContain('transcribeAudio');
    expect(tsContent).toContain('whisper');
    expect(tsContent).toContain('Invariants');

    const testContent = fs.readFileSync(testIntent, 'utf-8');
    expect(testContent).toContain('mockTranscribeAudio');
    expect(testContent).toContain('Invariants');
  });

  it('uses channel-agnostic transcription (no Baileys deps)', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'src', 'transcription.ts'),
      'utf-8',
    );

    // Uses local whisper.cpp CLI
    expect(content).toContain('whisper-cli');
    expect(content).toContain('execFileAsync');
    expect(content).toContain('WHISPER_BIN');
    expect(content).toContain('WHISPER_MODEL');
    expect(content).toContain('ggml-base.bin');

    // Channel-agnostic: takes Buffer, not WAMessage
    expect(content).toContain('audioBuffer: Buffer');
    expect(content).not.toContain('WAMessage');
    expect(content).not.toContain('WASocket');
    expect(content).not.toContain('downloadMediaMessage');
    expect(content).not.toContain('baileys');
    expect(content).not.toContain('openai');
    expect(content).not.toContain('OpenAI');
  });

  it('exports transcribeAudio with Buffer input', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'src', 'transcription.ts'),
      'utf-8',
    );

    expect(content).toContain('export async function transcribeAudio(');
    expect(content).toContain('audioBuffer: Buffer');
    expect(content).toContain('Promise<string | null>');
  });

  it('includes ffmpeg conversion step', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'src', 'transcription.ts'),
      'utf-8',
    );

    expect(content).toContain('ffmpeg');
    expect(content).toContain("'16000'");
  });

  it('cleans up temp files in finally block', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'src', 'transcription.ts'),
      'utf-8',
    );

    expect(content).toContain('finally');
    expect(content).toContain('unlinkSync');
  });

  it('modified telegram.ts imports transcribeAudio', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'telegram.ts'),
      'utf-8',
    );

    expect(content).toContain("import { transcribeAudio }");
    expect(content).toContain("'../transcription.js'");
  });

  it('modified telegram.ts has async voice handler with transcription', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'telegram.ts'),
      'utf-8',
    );

    expect(content).toContain("'message:voice'");
    expect(content).toContain('transcribeAudio(buffer)');
    expect(content).toContain('[Voice:');
    expect(content).toContain(
      '[Voice message - transcription unavailable]',
    );
    expect(content).toContain('ctx.api.getFile');
  });

  it('modified telegram.test.ts mocks transcription module', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'telegram.test.ts'),
      'utf-8',
    );

    expect(content).toContain('mockTranscribeAudio');
    expect(content).toContain("vi.mock('../transcription.js'");
    expect(content).toContain('transcribes voice message successfully');
    expect(content).toContain('falls back when transcription returns null');
    expect(content).toContain('falls back when voice download fails');
    expect(content).toContain('includes caption with transcribed voice');
    expect(content).toContain('ignores voice messages from unregistered');
  });
});
